import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  evaluatePriority,
  type Priority,
  type PriorityFacts,
  type PriorityRule,
  type PriorityRules,
  priorityRulesSchema,
} from '@tms/shared';
import type { RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AppSettingsService } from './app-settings.service';

const KEY = 'tickets.priority_rules';

/**
 * Priority rules (ADR 0032), kept as one ordered list in the settings store.
 * Read by the inbound pipeline on every message, so the store's short cache
 * matters; a change shows within seconds.
 */
@Injectable()
export class PriorityRulesService {
  constructor(private readonly settings: AppSettingsService) {}

  async get(): Promise<PriorityRules> {
    return (await this.settings.get(KEY, priorityRulesSchema)) ?? { rules: [] };
  }

  async save(ctx: RequestCtx, input: unknown): Promise<PriorityRules> {
    const parsed = new ZodPipe(priorityRulesSchema).transform(input) as PriorityRules;
    // A new rule from the console has no id yet; ids keep a rule recognisable in the audit trail.
    const rules: PriorityRule[] = parsed.rules.map((r) => ({
      ...r,
      id: r.id && r.id !== 'new' ? r.id : randomUUID().slice(0, 8),
    }));
    await this.settings.set(ctx, KEY, { rules }, { rules: rules.map((r) => r.name) });
    return { rules };
  }

  /** The priority the rules give these facts, and the rule that gave it; null when none matches. */
  async evaluate(facts: PriorityFacts): Promise<{ priority: Priority; rule: string } | null> {
    const { rules } = await this.get();
    const hit = evaluatePriority(rules, facts);
    return hit ? { priority: hit.priority, rule: hit.rule.name } : null;
  }
}
