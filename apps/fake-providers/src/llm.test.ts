import { describe, expect, it } from 'vitest';
import { chatCompletion, embed } from './llm';

describe('scripted LLM', () => {
  it('answers the connection test prompt with OK', () => {
    const r = chatCompletion({
      model: 'scripted-cheap',
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    });
    expect(r.choices[0]!.message.content).toBe('OK');
    expect(r.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('echoes other prompts, naming the model', () => {
    const req = { model: 'm', messages: [{ role: 'user', content: 'Where is my order?' }] };
    expect(chatCompletion(req).choices[0]!.message.content).toBe(
      'Scripted reply from m: "Where is my order?"',
    );
  });
});

describe('fake embeddings', () => {
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

  it('returns unit vectors of the requested size', () => {
    const v = embed('returns within thirty days', 256);
    expect(v).toHaveLength(256);
    expect(cos(v, v)).toBeCloseTo(1, 6);
  });

  it('puts texts that share words closer together', () => {
    const q = embed('how do I return a parcel');
    expect(cos(q, embed('you can return a parcel within 30 days'))).toBeGreaterThan(
      cos(q, embed('invoices are sent monthly by email')),
    );
  });
});
