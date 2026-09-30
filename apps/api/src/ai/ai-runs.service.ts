import { Inject, Injectable } from '@nestjs/common';
import { aiRuns, type Database, type DbOrTx } from '@tms/db';
import type { AiDecision, AiRule, AiRunView } from '@tms/shared';
import { and, desc, eq, gt, isNotNull, lt, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { AI_CTX } from '../common/request-context';
import { DB } from '../infra/tokens';

export interface NewAiRun {
  kind: 'turn' | 'classify';
  ticketId: string | null;
  conversationId?: string | null;
  triggerMessageId?: string | null;
  decision: AiDecision;
  confidence?: number | null;
  selfConfidence?: number | null;
  rules?: AiRule[];
  model?: string | null;
  promptVersion: string;
  tools?: Array<{ name: string; summary: string }>;
  sources?: Array<{ chunkId: string; label: string }>;
  replyMessageId?: string | null;
  language?: string | null;
  intent?: string | null;
  costUsd?: number;
  latencyMs?: number;
  error?: string | null;
}

/** Records what the AI did (ai_runs + audit + `ai.turn_completed`), and reads it back for agents. */
@Injectable()
export class AiRunsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async record(tx: DbOrTx, run: NewAiRun): Promise<string> {
    const [row] = await tx
      .insert(aiRuns)
      .values({
        ...run,
        rules: run.rules ?? [],
        tools: run.tools ?? [],
        sources: run.sources ?? [],
        error: run.error?.slice(0, 500) ?? null,
      })
      .returning({ id: aiRuns.id });
    if (run.ticketId) {
      const data = {
        runId: row!.id,
        kind: run.kind,
        decision: run.decision,
        confidence: run.confidence ?? null,
        rules: run.rules ?? [],
        model: run.model ?? null,
        promptVersion: run.promptVersion,
        tools: (run.tools ?? []).map((t) => t.name),
        sources: (run.sources ?? []).map((s) => s.chunkId),
        replyMessageId: run.replyMessageId ?? null,
      };
      await this.audit.record(tx, AI_CTX, {
        action: run.kind === 'classify' ? 'ai.classified' : 'ai.turn',
        targetType: 'ticket',
        targetId: run.ticketId,
        data,
      });
      await this.outbox.publish(tx, AI_CTX, {
        type: 'ai.turn_completed',
        aggregateType: 'ticket',
        aggregateId: run.ticketId,
        payload: { ...data, conversationId: run.conversationId ?? null },
      });
    }
    return row!.id;
  }

  async forTicket(ticketId: string): Promise<AiRunView[]> {
    const rows = await this.db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.ticketId, ticketId))
      .orderBy(desc(aiRuns.createdAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as AiRunView['kind'],
      decision: r.decision as AiDecision,
      confidence: r.confidence,
      rules: r.rules as AiRule[],
      model: r.model,
      promptVersion: r.promptVersion,
      tools: r.tools,
      sources: r.sources,
      replyMessageId: r.replyMessageId,
      language: r.language,
      intent: r.intent,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Turns in this conversation that weren't confident enough to send, since `after`. */
  async unconfidentTurns(conversationId: string, sendAt: number, after?: Date): Promise<number> {
    const where: SQL[] = [
      eq(aiRuns.conversationId, conversationId),
      eq(aiRuns.kind, 'turn'),
      isNotNull(aiRuns.confidence),
      lt(aiRuns.confidence, sendAt),
    ];
    if (after) where.push(gt(aiRuns.createdAt, after));
    return this.db.$count(aiRuns, and(...where));
  }
}
