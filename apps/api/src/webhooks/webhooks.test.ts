import type { DomainEvent, DomainEventType } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { isWebhookSource, toWebhookEvent } from './webhook-events';
import { buildSignatureHeader, generateWebhookSecret, verifySignatureHeader } from './webhook-sign';

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"d1","type":"ticket.created"}';
  const now = 1_790_000_000;

  it('signs "<time>.<body>" with HMAC-SHA256', () => {
    // A fixed vector: receivers in any language must produce the same value.
    expect(buildSignatureHeader(body, secret, now)).toBe(
      't=1790000000,v1=00c77c95442d04dd586e98d6f729b5f1761b29b2af360c13679ea85340a19a89',
    );
  });

  it('accepts its own signature and tolerates case and spaces', () => {
    const header = buildSignatureHeader(body, secret, now);
    expect(verifySignatureHeader(header, body, secret, now)).toBe(true);
    const [t, v1] = header.split(',');
    expect(
      verifySignatureHeader(`${t}, ${v1!.toUpperCase().replace('V1', 'v1')}`, body, secret, now),
    ).toBe(true);
  });

  it('refuses a changed body, another secret, an old timestamp and nonsense', () => {
    const header = buildSignatureHeader(body, secret, now);
    expect(verifySignatureHeader(header, `${body} `, secret, now)).toBe(false);
    expect(verifySignatureHeader(header, body, 'whsec_other', now)).toBe(false);
    // Five minutes of tolerance, then it is a replay.
    expect(verifySignatureHeader(header, body, secret, now + 300)).toBe(true);
    expect(verifySignatureHeader(header, body, secret, now + 301)).toBe(false);
    expect(verifySignatureHeader('', body, secret, now)).toBe(false);
    expect(verifySignatureHeader('t=abc,v1=zz', body, secret, now)).toBe(false);
    expect(verifySignatureHeader(`t=${now},v1=abcd`, body, secret, now)).toBe(false);
  });

  it('makes secrets that are recognisable and never repeat', () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe('which events leave as webhooks', () => {
  const event = (
    type: DomainEventType,
    payload: Record<string, unknown> = {},
    aggregateId = 'agg-1',
  ): DomainEvent => ({
    id: 'e1',
    type,
    aggregateType: 'ticket',
    aggregateId,
    occurredAt: '2026-10-01T10:00:00.000Z',
    actor: { type: 'system', id: null },
    payload,
  });

  it('maps ticket events, keeping identifiers and status keys only', () => {
    expect(toWebhookEvent(event('ticket.created', { number: 'TMS-1', customerId: 'c1' }))).toEqual({
      type: 'ticket.created',
      refs: { ticketId: 'agg-1' },
    });
    expect(toWebhookEvent(event('ticket.status_changed', { from: 'new', to: 'resolved' }))).toEqual(
      {
        type: 'ticket.status_changed',
        refs: { ticketId: 'agg-1', from: 'new', to: 'resolved' },
      },
    );
    // Which fields changed, not what they changed to.
    expect(
      toWebhookEvent(
        event('ticket.updated', { changes: { subject: { from: 'Secret old', to: 'Secret new' } } }),
      ),
    ).toEqual({ type: 'ticket.updated', refs: { ticketId: 'agg-1', changed: ['subject'] } });
  });

  it('tells about customer-visible messages, never drafts or notes', () => {
    for (const type of ['message.received', 'message.outbound'] as const) {
      expect(toWebhookEvent(event(type, { conversationId: 'cv', messageId: 'm1' }))).toEqual({
        type: 'message.created',
        refs: { ticketId: 'agg-1', messageId: 'm1' },
      });
    }
    for (const type of [
      'message.drafted',
      'message.draft_reviewed',
      'ticket.note_added',
      'ai.turn_completed',
      'settings.secret_changed',
      'tool.called',
    ] as const) {
      expect(toWebhookEvent(event(type, { messageId: 'm1' })), type).toBeNull();
      expect(isWebhookSource(type), type).toBe(false);
    }
  });

  it('maps incidents and approvals with the ticket they concern', () => {
    expect(
      toWebhookEvent(event('incident.opened', { integrationId: 'int-1', ticketId: 't1' }, 'inc-1')),
    ).toEqual({
      type: 'incident.opened',
      refs: { incidentId: 'inc-1', integrationId: 'int-1', ticketId: 't1' },
    });
    expect(
      toWebhookEvent(event('approval.decided', { ticketId: 't1', decision: 'approved' }, 'ap-1')),
    ).toEqual({
      type: 'approval.decided',
      refs: { approvalId: 'ap-1', ticketId: 't1', decision: 'approved' },
    });
    expect(isWebhookSource('incident.resolved')).toBe(true);
    expect(isWebhookSource('csat.submitted')).toBe(true);
  });
});
