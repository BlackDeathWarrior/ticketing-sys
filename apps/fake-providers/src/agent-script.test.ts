import { describe, expect, it } from 'vitest';
import { agentReply, classifierReply, isAgentRequest } from './agent-script';
import type { ChatRequest } from './llm';

const tools = ['search_knowledge', 'update_ticket', 'request_human', 'send_reply'].map((name) => ({
  type: 'function',
  function: { name },
}));

const agent = (question: string, toolResult?: unknown): ChatRequest => ({
  model: 'scripted-cheap',
  tools,
  messages: [
    { role: 'system', content: 'rules' },
    { role: 'user', content: `<customer_message>\n${question}\n</customer_message>` },
    ...(toolResult !== undefined ? [{ role: 'tool', content: JSON.stringify(toolResult) }] : []),
  ],
});

const args = (r: ReturnType<typeof agentReply>) => r.toolCalls![0]!.arguments;

describe('scripted agent', () => {
  it('recognises agent requests by their send_reply tool', () => {
    expect(isAgentRequest(agent('x'))).toBe(true);
    expect(isAgentRequest({ model: 'm', messages: [] })).toBe(false);
  });

  it('searches first, then answers confidently from a matching passage', () => {
    expect(agentReply(agent('When will my refund reach my card?')).toolCalls![0]!.name).toBe(
      'search_knowledge',
    );
    const r = agentReply(
      agent('When will my refund reach my card?', {
        results: [
          {
            id: 'c1',
            source: 'Returns › Refund timing',
            text: 'Refunds to cards take 5 to 7 days. More text.',
          },
        ],
      }),
    );
    expect(r.toolCalls![0]!.name).toBe('send_reply');
    expect(args(r)).toMatchObject({
      confidence: 0.9,
      sources: ['c1'],
      language: 'en',
      resolves_issue: true,
    });
    expect(String(args(r).message)).toContain('5 to 7 days');
  });

  it('is less sure when the passage barely matches, and unsure with nothing', () => {
    const weak = agentReply(
      agent('What do penguins eat?', {
        results: [{ id: 'c2', source: 'Billing', text: 'Invoices are emailed.' }],
      }),
    );
    expect(args(weak).confidence).toBe(0.7);
    expect(args(agentReply(agent('Anything?', { results: [] }))).confidence).toBe(0.3);
  });

  it('asks for a person when the customer does, and answers Hindi in Hindi', () => {
    expect(agentReply(agent('Let me talk to a real person')).toolCalls![0]!.name).toBe(
      'request_human',
    );
    const hi = agentReply(
      agent('मेरा रिफंड कब आएगा?', {
        results: [{ id: 'c3', source: 'रिफंड', text: 'रिफंड कब आएगा: 5 से 7 दिन।' }],
      }),
    );
    expect(args(hi).language).toBe('hi');
    expect(String(args(hi).message).startsWith('धन्यवाद।')).toBe(true);
  });
});

describe('scripted classifier', () => {
  it('picks the best-matching category and flags urgency', () => {
    const r = classifierReply({
      model: 'm',
      messages: [
        {
          role: 'system',
          content:
            'You classify support tickets.\n- Billing > Duplicate charge\n- Orders > Tracking',
        },
        {
          role: 'user',
          content: '<ticket>Charged twice - duplicate charge on my card, URGENT</ticket>',
        },
      ],
    });
    expect(JSON.parse(r.content!)).toMatchObject({
      category: 'Billing',
      subcategory: 'Duplicate charge',
      priority: 'urgent',
      confidence: 0.85,
    });
  });
});
