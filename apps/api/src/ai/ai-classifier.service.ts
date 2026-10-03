import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import { type AiClassification, INCIDENT_TICKET_KIND, SENTIMENTS, smallTalk } from '@tms/shared';
import { z } from 'zod';
import { AI_CTX } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { LlmClientService, LlmUnavailableError } from '../llm/llm-client.service';
import { OrgService } from '../org/org.service';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { PriorityRulesService } from '../settings/priority-rules.service';
import { TicketsService } from '../tickets/tickets.service';
import { AiRunsService } from './ai-runs.service';
import { CLASSIFIER_PROMPT_VERSION, classifierSystemPrompt } from './prompts';

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const;
type Priority = keyof typeof RANK;

const outputSchema = z.object({
  category: z.string().nullable().optional(),
  subcategory: z.string().nullable().optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).nullable().optional().catch(null),
  language: z.string().max(10).nullable().optional(),
  intent: z.string().max(60).nullable().optional(),
  sentiment: z.enum(SENTIMENTS).nullable().optional().catch(null),
  confidence: z.coerce.number().min(0).max(1).catch(0.5).default(0.5),
});

import { extractJson } from './json';

export { extractJson };

/**
 * Classifies new customer tickets with the `classifier` role: category,
 * priority, language, intent and sentiment. It only fills gaps: a category
 * set by a person is kept, and priority is only ever raised (confidence ≥ 0.6).
 */
@Injectable()
export class AiClassifierService {
  private readonly logger = new Logger(AiClassifierService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly llm: LlmClientService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly org: OrgService,
    private readonly behaviour: AiBehaviourService,
    private readonly runs: AiRunsService,
    private readonly priorityRules: PriorityRulesService,
  ) {}

  async classify(ticketId: string): Promise<AiClassification | null> {
    if (!(await this.behaviour.get()).classifyTickets) return null;
    const ticket = await this.tickets.get(ticketId).catch(() => null);
    if (!ticket || ticket.aiClassification) return null;
    // An incident an app reported about itself: its severity and source are facts, not guesses.
    if (ticket.metadata.kind === INCIDENT_TICKET_KIND) return null;

    const tree = await this.org.activeCategories();
    const labels = tree.flatMap((c) =>
      c.children.length ? c.children.map((s) => `${c.name} > ${s.name}`) : [c.name],
    );
    // "Hello" has no category, priority or intent to find: do not spend a call on it.
    if (smallTalk(`${ticket.description ?? ticket.subject}`)) return null;
    const started = Date.now();
    let raw: string;
    let model: string | null = null;
    let cost = 0;
    try {
      const r = await this.llm.chat({
        role: 'classifier',
        messages: [
          { role: 'system', content: classifierSystemPrompt(labels) },
          {
            role: 'user',
            content: `<ticket>\n${ticket.subject}\n\n${(ticket.description ?? '').slice(0, 4000)}\n</ticket>`,
          },
        ],
        responseFormat: { type: 'json_object' },
        // Room for a model that reasons before it answers: 300 left some with half a JSON object.
        maxTokens: 1500,
        temperature: 0,
        ticketId,
      });
      raw = r.completion.choices[0]?.message.content ?? '';
      model = r.model;
      cost = r.costUsd;
    } catch (err) {
      if (err instanceof LlmUnavailableError) return null;
      await this.db.transaction((tx) =>
        this.runs.record(tx, {
          kind: 'classify',
          ticketId,
          decision: 'error',
          promptVersion: CLASSIFIER_PROMPT_VERSION,
          error: (err as Error).message,
          latencyMs: Date.now() - started,
        }),
      );
      return null;
    }

    const parsed = outputSchema.safeParse(extractJson(raw));
    if (!parsed.success) {
      this.logger.warn(`classifier returned unusable output for ${ticket.reference}`);
      return null;
    }
    const o = parsed.data;
    const classification: AiClassification = {
      category: o.category ?? null,
      subcategory: o.subcategory ?? null,
      priority: o.priority ?? null,
      language: o.language?.split('-')[0]?.toLowerCase() ?? null,
      intent: o.intent ?? null,
      sentiment: o.sentiment ?? null,
      confidence: o.confidence,
      model,
      at: new Date().toISOString(),
    };

    const patch: { categoryId?: string; subcategoryId?: string; priority?: Priority } = {};
    if (!ticket.categoryId && classification.category && o.confidence >= 0.6) {
      const cat = tree.find((c) => c.name.toLowerCase() === classification.category!.toLowerCase());
      const subName = (classification.subcategory ?? '').toLowerCase();
      if (cat) {
        patch.categoryId = cat.id;
        const sub = cat.children.find((s) => s.name.toLowerCase() === subName);
        if (sub) patch.subcategoryId = sub.id;
      }
    }
    const current = ticket.priority as Priority;
    if (
      classification.priority &&
      o.confidence >= 0.6 &&
      RANK[classification.priority] > RANK[current]
    ) {
      patch.priority = classification.priority;
    }
    // The company's rules know the intent and the mood now (ADR 0032); they only ever raise.
    const ruled = await this.priorityRules
      .evaluate({
        channel: ticket.channel,
        categoryId: patch.categoryId ?? ticket.categoryId,
        subcategoryId: patch.subcategoryId ?? ticket.subcategoryId,
        customerType: ticket.customer.customerType ?? null,
        tags: ticket.tags,
        text: `${ticket.subject}\n${ticket.description ?? ''}`,
        intent: classification.intent,
        sentiment: classification.sentiment,
        metadata: ticket.metadata ?? {},
      })
      .catch(() => null);
    if (ruled && RANK[ruled.priority] > RANK[patch.priority ?? current]) {
      patch.priority = ruled.priority;
    }

    await this.db.transaction(async (tx) => {
      await this.tickets.applyClassification(tx, AI_CTX, ticketId, { ...classification }, patch);
      await this.runs.record(tx, {
        kind: 'classify',
        ticketId,
        decision: 'sent',
        confidence: o.confidence,
        model,
        promptVersion: CLASSIFIER_PROMPT_VERSION,
        language: classification.language,
        intent: classification.intent,
        costUsd: cost,
        latencyMs: Date.now() - started,
      });
    });

    if (classification.language) {
      const customer = await this.customers.get(ticket.customerId);
      if (!customer.language) {
        await this.customers
          .update(AI_CTX, customer.id, { language: classification.language })
          .catch(() => undefined);
      }
    }
    return classification;
  }
}
