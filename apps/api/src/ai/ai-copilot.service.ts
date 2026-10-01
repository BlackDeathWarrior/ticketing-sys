import { Injectable } from '@nestjs/common';
import type { CopilotSuggestion } from '@tms/shared';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ConversationsService } from '../conversations/conversations.service';
import { KbSearchService } from '../kb/kb-search.service';
import { LlmClientService } from '../llm/llm-client.service';
import { TicketsService } from '../tickets/tickets.service';
import { BrandingService } from '../settings/branding.service';
import { copilotSystemPrompt, customerTurn } from './prompts';

/**
 * Suggests a reply for an agent (the `copilot` role, ADR 0014). Nothing is
 * stored or sent: the agent edits it in the composer and sends it as their
 * own reply, which is audited like any other.
 */
@Injectable()
export class AiCopilotService {
  constructor(
    private readonly tickets: TicketsService,
    private readonly conversations: ConversationsService,
    private readonly kb: KbSearchService,
    private readonly llm: LlmClientService,
    private readonly branding: BrandingService,
  ) {}

  async suggest(ticketRef: string, instruction: string | null): Promise<CopilotSuggestion> {
    const ticket = await this.tickets.get(ticketRef);
    const convs = await this.conversations.listForTicket(ticket.id);
    const latest = convs.sort(
      (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
    )[0];
    const rows = latest ? await this.conversations.transcript(latest.id, 20) : [];
    const lastCustomer =
      [...rows].reverse().find((m) => m.authorType === 'customer')?.body ??
      ticket.description ??
      ticket.subject;

    const res = await this.kb
      .search(
        { ticketId: ticket.id },
        { q: lastCustomer.slice(0, 300), limit: 3, audience: 'customer', includeDrafts: false },
      )
      .catch(() => ({ hits: [] }));
    const knowledge = res.hits.map((h) => ({
      id: h.chunkId,
      label: h.citation.label,
      text: h.snippet,
    }));

    const history: ChatCompletionMessageParam[] = rows.length
      ? rows.map((m) =>
          m.authorType === 'customer'
            ? { role: 'user', content: customerTurn(m.body) }
            : { role: 'assistant', content: m.body },
        )
      : [{ role: 'user', content: customerTurn(lastCustomer) }];

    const r = await this.llm.chat({
      role: 'copilot',
      messages: [
        {
          role: 'system',
          content: copilotSystemPrompt({
            company: await this.branding.get(),
            channel: latest?.channel ?? ticket.channel,
            customer: ticket.customer.displayName,
            knowledge,
            instruction,
          }),
        },
        ...history,
      ],
      maxTokens: 500,
      temperature: 0.3,
      ticketId: ticket.id,
      conversationId: latest?.id ?? null,
    });
    return {
      suggestion: r.completion.choices[0]?.message.content?.trim() ?? '',
      sources: knowledge.map((k) => ({ chunkId: k.id, label: k.label })),
      model: r.model,
    };
  }
}
