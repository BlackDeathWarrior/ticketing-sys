import { describe, expect, it } from 'vitest';
import {
  rankCandidates,
  roleWarning,
  routeOrder,
  type RouterModel,
  type RouterProvider,
} from './llm-router';

const perM = (usd: number) => usd / 1_000_000;

function model(id: string, over: Partial<RouterModel> = {}): RouterModel {
  return {
    id,
    providerId: 'p1',
    provider: 'openai',
    label: id,
    mode: 'chat',
    supportsTools: true,
    supportsJson: true,
    inputCostPerToken: perM(1),
    outputCostPerToken: perM(4),
    enabled: true,
    ...over,
  };
}

const providers: RouterProvider[] = [
  { id: 'p1', enabled: true, budgetUsd: null, spentUsd: 0 },
  { id: 'p2', enabled: true, budgetUsd: 10, spentUsd: 2 },
];

describe('rankCandidates', () => {
  it('orders capable models cheapest first by blended cost, unknown cost last', () => {
    const models = [
      model('premium', { inputCostPerToken: perM(3), outputCostPerToken: perM(15) }),
      model('unknown', { inputCostPerToken: null, outputCostPerToken: null }),
      model('cheap', {
        inputCostPerToken: perM(0.1),
        outputCostPerToken: perM(0.4),
        providerId: 'p2',
      }),
    ];
    const c = rankCandidates('chat_agent', { mode: 'cheapest', modelIds: [] }, models, providers);
    expect(c.map((x) => x.modelId)).toEqual(['cheap', 'premium', 'unknown']);
    // (3 × 0.1 + 0.4) / 4 = 0.175
    expect(c[0]!.blendedCostPerMTok).toBeCloseTo(0.175);
  });

  it('skips a provider at or over its budget, so traffic moves to the next model', () => {
    const models = [
      model('cheap', { providerId: 'p2', inputCostPerToken: perM(0.1) }),
      model('other', { inputCostPerToken: perM(2) }),
    ];
    const capped = [providers[0]!, { ...providers[1]!, budgetUsd: 2, spentUsd: 2 }];
    const c = rankCandidates('chat_agent', { mode: 'cheapest', modelIds: [] }, models, capped);
    expect(c[0]).toMatchObject({ modelId: 'cheap', skipped: 'over_budget' });
    expect(routeOrder(c, 'chat_agent')).toEqual(['other']);
  });

  it('a zero budget blocks the provider entirely', () => {
    const c = rankCandidates(
      'classifier',
      { mode: 'cheapest', modelIds: [] },
      [model('m', { providerId: 'p2' })],
      [{ id: 'p2', enabled: true, budgetUsd: 0, spentUsd: 0 }],
    );
    expect(c[0]!.skipped).toBe('over_budget');
    expect(roleWarning('classifier', c)).toMatch(/over its budget/);
  });

  it('marks models without tool calling as unusable for the agent roles', () => {
    const c = rankCandidates(
      'chat_agent',
      { mode: 'cheapest', modelIds: [] },
      [model('no-tools', { supportsTools: false })],
      providers,
    );
    expect(c[0]!.skipped).toBe('missing_capability');
    expect(roleWarning('chat_agent', c)).toMatch(/tool calling/);
    // The summarizer doesn't need tools.
    const s = rankCandidates(
      'summarizer',
      { mode: 'cheapest', modelIds: [] },
      [model('no-tools', { supportsTools: false })],
      providers,
    );
    expect(s[0]!.skipped).toBeUndefined();
  });

  it('respects disabled providers and models', () => {
    const c = rankCandidates(
      'copilot',
      { mode: 'cheapest', modelIds: [] },
      [model('a', { enabled: false }), model('b', { providerId: 'p3' })],
      [...providers, { id: 'p3', enabled: false, budgetUsd: null, spentUsd: 0 }],
    );
    expect(c.map((x) => x.skipped).sort()).toEqual(['model_disabled', 'provider_disabled']);
    expect(routeOrder(c, 'copilot')).toEqual([]);
  });

  it('uses exactly the listed models, in order, for an ordered role', () => {
    const models = [model('a'), model('b'), model('c', { inputCostPerToken: 0 })];
    const c = rankCandidates(
      'chat_agent',
      { mode: 'ordered', modelIds: ['b', 'a'] },
      models,
      providers,
    );
    expect(routeOrder(c, 'chat_agent')).toEqual(['b', 'a']);
  });

  it('limits cheapest routing to an allowlist when one is set', () => {
    const models = [
      model('a', { inputCostPerToken: perM(5) }),
      model('b'),
      model('c', { inputCostPerToken: 0 }),
    ];
    const c = rankCandidates(
      'chat_agent',
      { mode: 'cheapest', modelIds: ['a', 'b'] },
      models,
      providers,
    );
    expect(routeOrder(c, 'chat_agent')).toEqual(['b', 'a']);
  });

  it('pins embeddings to one model with no fallback, and ignores chat models', () => {
    const models = [
      model('chat'),
      model('e1', { mode: 'embedding', supportsTools: false }),
      model('e2', { mode: 'embedding', supportsTools: false }),
    ];
    const c = rankCandidates(
      'embedding',
      { mode: 'ordered', modelIds: ['e2', 'e1'] },
      models,
      providers,
    );
    expect(c.map((x) => x.modelId)).toEqual(['e2', 'e1']);
    expect(routeOrder(c, 'embedding')).toEqual(['e2']);
  });

  it('warns when nothing is registered', () => {
    expect(roleWarning('embedding', [])).toMatch(/No embedding model/);
  });
});
