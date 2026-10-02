import type { Permission } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import {
  canOpenSettings,
  catalogueFacts,
  catalogueOption,
  formatPerMTok,
  formatUsd,
  maskedKey,
  move,
  parseBudget,
  visibleTabs,
} from './logic';

const can = (perms: Permission[]) => (p: Permission) => perms.includes(p);

describe('settings tabs', () => {
  it('shows every tab to an admin and nothing to an agent', () => {
    const admin = can([
      'settings:llm',
      'settings:channels',
      'settings:secrets',
      'settings:ai',
      'tool:manage',
      'integration:manage',
      'settings:routing',
      'settings:sla',
      'settings:categories',
      'settings:workflow',
      'user:manage',
      'system:manage',
    ]);
    expect(visibleTabs(admin).map((t) => t.value)).toEqual([
      'providers',
      'models',
      'ai',
      'channels',
      'customers',
      'tools',
      'integrations',
      'routing',
      'sla',
      'tickets',
      'people',
      'usage',
      'system',
    ]);
    // Everyone has their own settings (notification sound).
    expect(canOpenSettings(can(['ticket:read']))).toBe(true);
  });

  it('shows channels and customers to someone with channel settings alone', () => {
    expect(visibleTabs(can(['settings:channels'])).map((t) => t.value)).toEqual([
      'channels',
      'customers',
    ]);
  });

  it('opens Tools for someone who may only create custom tools', () => {
    const lead = can(['ticket:read', 'tool:create']);
    expect(visibleTabs(lead).map((t) => t.value)).toEqual(['tools']);
    expect(canOpenSettings(lead)).toBe(true);
  });
});

describe('formatting', () => {
  it('formats money at a useful precision', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.00042)).toBe('$0.0004');
    expect(formatUsd(0.00003)).toBe('<$0.0001');
    expect(formatUsd(3.456)).toBe('$3.46');
    expect(formatUsd(1234.5)).toBe('$1,235');
    expect(formatUsd(null)).toBe('—');
  });

  it('formats per-million-token prices', () => {
    expect(formatPerMTok(0.1)).toBe('$0.1');
    expect(formatPerMTok(0.075)).toBe('$0.075');
    expect(formatPerMTok(15)).toBe('$15.00');
    expect(formatPerMTok(null)).toBe('unknown');
  });

  it('describes a model that can be chosen', () => {
    const flash = {
      model: 'gemini-flash-latest',
      mode: 'chat' as const,
      supportsTools: true,
      supportsJson: true,
      supportsVision: true,
      contextWindow: 1_048_576,
      inputCostPerMTok: 0.3,
      outputCostPerMTok: 2.5,
      retiresOn: '2027-02-05',
      added: false,
    };
    expect(catalogueOption(flash)).toBe('gemini-flash-latest · $0.3 in / $2.50 out');
    expect(catalogueFacts(flash)).toBe(
      'Can use tools, JSON, images · reads up to 1,048,576 tokens · the provider retires it on 2027-02-05.',
    );
    const embedding = {
      ...flash,
      model: 'gemini-embedding-001',
      mode: 'embedding' as const,
      supportsTools: false,
      supportsJson: false,
      supportsVision: false,
      contextWindow: 2048,
      inputCostPerMTok: 0.15,
      outputCostPerMTok: 0,
      retiresOn: null,
      added: true,
    };
    expect(catalogueOption(embedding)).toBe('gemini-embedding-001 · $0.15 per 1M · already added');
    expect(catalogueFacts(embedding)).toBe('reads up to 2,048 tokens.');
    const unknown = {
      ...flash,
      model: 'new-model',
      supportsTools: false,
      supportsJson: false,
      supportsVision: false,
      contextWindow: null,
      inputCostPerMTok: null,
      outputCostPerMTok: null,
      retiresOn: null,
    };
    expect(catalogueOption(unknown)).toBe('new-model');
    expect(catalogueFacts(unknown)).toBe(
      'No tool calling: the AI agent cannot use it · price unknown: set one below.',
    );
  });

  it('masks keys to the last four characters', () => {
    expect(maskedKey('abcd')).toBe('••••abcd');
    expect(maskedKey(null)).toBe('••••');
    expect(maskedKey(null, false)).toBe('Not set');
  });
});

describe('form helpers', () => {
  it('parses budgets, treating empty as no cap', () => {
    expect(parseBudget('')).toBeNull();
    expect(parseBudget('$10')).toBe(10);
    expect(parseBudget('0')).toBe(0);
    expect(parseBudget('-1')).toBe('invalid');
    expect(parseBudget('ten')).toBe('invalid');
  });

  it('reorders a list', () => {
    expect(move(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
