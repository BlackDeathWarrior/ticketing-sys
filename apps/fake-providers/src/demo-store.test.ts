import { beforeEach, describe, expect, it } from 'vitest';
import { agentReply } from './agent-script';
import {
  DemoStoreError,
  issueRefund,
  lookupCustomer,
  orderStatus,
  paymentStatus,
  resetDemoStore,
} from './demo-store';
import type { ChatRequest } from './llm';

beforeEach(() => resetDemoStore());

describe('Demo Store systems', () => {
  it('answers only about the customer’s own orders', () => {
    expect(orderStatus('ds-10421', 'Bea.Sandoval@example.com')).toMatchObject({
      order_id: 'DS-10421',
      status: 'shipped',
      tracking_number: 'NW-7731-0042',
    });
    // Someone else's order looks exactly like a missing one.
    expect(() => orderStatus('DS-10421', 'omar.farouk@example.org')).toThrow(
      'No order DS-10421 was found for this customer',
    );
    expect(() => orderStatus('DS-99999', 'omar.farouk@example.org')).toThrow(DemoStoreError);
    expect(lookupCustomer('tom.whitaker@example.com').orders).toEqual([
      { order_id: 'DS-10388', placed_at: '2026-09-12', status: 'delivered' },
    ]);
  });

  it('gives sandbox shoppers their DS-9xxxx orders on first use, and to nobody else', () => {
    expect(orderStatus('DS-91234', 'Ines@shopper.example')).toMatchObject({
      order_id: 'DS-91234',
      status: 'delivered',
    });
    expect(paymentStatus('DS-91234', 'ines@shopper.example').duplicate_charge).toBe(true);
    expect(() => orderStatus('DS-91234', 'other@shopper.example')).toThrow(DemoStoreError);
    expect(() => orderStatus('DS-12345', 'ines@shopper.example')).toThrow(DemoStoreError);
    resetDemoStore();
    expect(() => orderStatus('DS-91234', 'other@shopper.example')).not.toThrow();
  });

  it('spots a duplicate charge and refunds it once', () => {
    expect(paymentStatus('DS-10388', 'tom.whitaker@example.com')).toMatchObject({
      order_total: 59.9,
      charged_total: 119.8,
      duplicate_charge: true,
    });
    const refund = issueRefund('DS-10388', 'tom.whitaker@example.com', undefined, 'Charged twice');
    expect(refund).toMatchObject({ refund_id: 'RF-5000', amount: 59.9, currency: 'EUR' });
    expect(paymentStatus('DS-10388', 'tom.whitaker@example.com').refunds).toHaveLength(1);
    // What is left is the real purchase; more than that is refused.
    expect(() => issueRefund('DS-10388', 'tom.whitaker@example.com', 100, 'Again')).toThrow(
      'At most 59.90 EUR can be refunded',
    );
  });
});

const tools = [
  'search_knowledge',
  'send_reply',
  'demo_store__order_status',
  'demo_store__issue_refund',
];
const req = (messages: ChatRequest['messages']): ChatRequest => ({
  model: 'scripted-cheap',
  messages,
  tools: tools.map((name) => ({ type: 'function', function: { name } })),
});
const user = (text: string) => ({
  role: 'user',
  content: `<customer_message>\n${text}\n</customer_message>`,
});

describe('scripted agent with company tools', () => {
  it('looks up an order, then reports its status', () => {
    const first = agentReply(
      req([{ role: 'system', content: 'x' }, user('Where is my order DS-10421?')]),
    );
    expect(first.toolCalls?.[0]).toEqual({
      name: 'demo_store__order_status',
      arguments: { order_id: 'DS-10421' },
    });
    const second = agentReply(
      req([
        { role: 'system', content: 'x' },
        user('Where is my order DS-10421?'),
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'demo_store__order_status' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: JSON.stringify({
            ok: true,
            result: { order_id: 'DS-10421', status: 'shipped', carrier: 'Northwind Parcel' },
          }),
        },
      ]),
    );
    expect(second.toolCalls?.[0]?.name).toBe('send_reply');
    expect(second.toolCalls?.[0]?.arguments.message).toBe(
      'Order DS-10421 is shipped with Northwind Parcel.',
    );
  });

  it('asks for a refund, says it is with the team, then reports the decision', () => {
    const q = 'I was charged twice for order DS-10388, please refund me';
    const first = agentReply(req([{ role: 'system', content: 'x' }, user(q)]));
    expect(first.toolCalls?.[0]?.name).toBe('demo_store__issue_refund');
    const pending = agentReply(
      req([
        { role: 'system', content: 'x' },
        user(q),
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'demo_store__issue_refund' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: JSON.stringify({ status: 'pending_approval' }),
        },
      ]),
    );
    expect(String(pending.toolCalls?.[0]?.arguments.message)).toContain('to our team for approval');

    const done = agentReply(
      req([
        {
          role: 'system',
          content:
            '<approval_update tool="Issue refund" status="done">\n{"refund_id":"RF-5000","order_id":"DS-10388","amount":59.9,"currency":"EUR"}\n</approval_update>',
        },
        user(q),
      ]),
    );
    expect(String(done.toolCalls?.[0]?.arguments.message)).toContain(
      'your refund of 59.90 EUR for order DS-10388 has been issued (reference RF-5000)',
    );
  });

  it('leaves questions without an order number to the knowledge base', () => {
    const r = agentReply(
      req([{ role: 'system', content: 'x' }, user('When will my refund reach my card?')]),
    );
    expect(r.toolCalls?.[0]?.name).toBe('search_knowledge');
  });
});
