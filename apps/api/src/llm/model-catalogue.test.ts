import { describe, expect, it } from 'vitest';
import { catalogueFor, type CostMap } from './model-catalogue';

const map: CostMap = {
  'gemini/gemini-2.0-flash': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 1e-7,
    output_cost_per_token: 4e-7,
    max_input_tokens: 1_048_576,
    supports_function_calling: true,
    supports_response_schema: true,
    supports_vision: true,
    supported_output_modalities: ['text', 'image'],
    deprecation_date: '2027-02-05',
  },
  'gemini/gemini-10.1-flash': { litellm_provider: 'gemini', mode: 'chat' },
  'gemini/gemini-flash-latest': {
    litellm_provider: 'gemini',
    mode: 'chat',
    supports_function_calling: true,
  },
  // The same model under its bare name is one choice, not two.
  'gemini-flash-latest': { litellm_provider: 'gemini', mode: 'chat' },
  'gemini/gemini-embedding-001': {
    litellm_provider: 'gemini',
    mode: 'embedding',
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 0,
  },
  'gemini/old-flash': { litellm_provider: 'gemini', mode: 'chat', deprecation_date: '2026-05-25' },
  'gemini/music-maker': {
    litellm_provider: 'gemini',
    mode: 'chat',
    supported_output_modalities: ['audio'],
  },
  'gemini/imagen': { litellm_provider: 'gemini', mode: 'image_generation' },
  'gemini/has a space': { litellm_provider: 'gemini', mode: 'chat' },
  'gemini-pro-vertex': { litellm_provider: 'vertex_ai-language-models', mode: 'chat' },
  'claude-haiku-4-5': { litellm_provider: 'anthropic', mode: 'chat' },
  sample_spec: { litellm_provider: 'one of the providers', mode: 'chat' },
};

describe('catalogueFor', () => {
  it("lists a provider's chat and embedding models: aliases first, then by name", () => {
    const models = catalogueFor(map, 'gemini', '2026-10-02');
    expect(models.map((m) => m.model)).toEqual([
      'gemini-flash-latest',
      'gemini-2.0-flash',
      'gemini-10.1-flash',
      'gemini-embedding-001',
    ]);
    expect(models.find((m) => m.model === 'gemini-2.0-flash')).toEqual({
      model: 'gemini-2.0-flash',
      mode: 'chat',
      supportsTools: true,
      supportsJson: true,
      supportsVision: true,
      contextWindow: 1_048_576,
      inputCostPerMTok: 0.1,
      outputCostPerMTok: 0.4,
      retiresOn: '2027-02-05',
    });
    expect(models.find((m) => m.model === 'gemini-embedding-001')).toMatchObject({
      mode: 'embedding',
      inputCostPerMTok: 0.15,
      outputCostPerMTok: 0,
    });
    // What LiteLLM does not say is unknown, not zero.
    expect(models.find((m) => m.model === 'gemini-10.1-flash')).toMatchObject({
      supportsTools: false,
      contextWindow: null,
      inputCostPerMTok: null,
      retiresOn: null,
    });
  });

  it('leaves out retired models, ones that do not answer in text, and other providers', () => {
    const names = catalogueFor(map, 'gemini', '2026-10-02').map((m) => m.model);
    for (const gone of ['old-flash', 'music-maker', 'imagen', 'has a space', 'gemini-pro-vertex']) {
      expect(names).not.toContain(gone);
    }
    // Still offered on the day before it is retired.
    expect(catalogueFor(map, 'gemini', '2026-05-24').map((m) => m.model)).toContain('old-flash');
  });

  it('reads providers whose models carry no prefix in the list', () => {
    expect(catalogueFor(map, 'anthropic', '2026-10-02').map((m) => m.model)).toEqual([
      'claude-haiku-4-5',
    ]);
  });

  it('has nothing for endpoints whose models only their owner knows', () => {
    expect(catalogueFor(map, 'openai_compatible', '2026-10-02')).toEqual([]);
    expect(catalogueFor(map, 'ollama', '2026-10-02')).toEqual([]);
    expect(catalogueFor({}, 'gemini', '2026-10-02')).toEqual([]);
  });
});
