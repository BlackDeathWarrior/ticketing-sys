import { describe, expect, it } from 'vitest';
import { csatSubmitSchema, customerExperienceSchema, isLowRating, isSatisfied } from './csat';
import { type Permission, SYSTEM_ROLES, type SystemRoleKey } from './permissions';
import { portalReplySchema, portalSignInSchema } from './portal';
import {
  csvCell,
  daysBetween,
  rate,
  reportPeriod,
  reportQuerySchema,
  ticketReportCsv,
  type TicketReportRow,
} from './reports';

const now = new Date('2026-10-15T09:30:00Z');
const hasPermission = (role: SystemRoleKey, permission: Permission) =>
  (SYSTEM_ROLES[role].permissions as readonly Permission[]).includes(permission);

describe('report period', () => {
  it('counts back from today, both ends included', () => {
    expect(reportPeriod({ days: 7 }, now)).toEqual({ from: '2026-10-09', to: '2026-10-15' });
    expect(reportPeriod({ days: 1 }, now)).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(daysBetween('2026-10-09', '2026-10-15')).toHaveLength(7);
  });

  it('uses explicit dates when given, across a month end', () => {
    expect(reportPeriod({ days: 30, from: '2026-09-28', to: '2026-10-02' }, now)).toEqual({
      from: '2026-09-28',
      to: '2026-10-02',
    });
    expect(daysBetween('2026-09-28', '2026-10-02')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
    // Only a first day: the period runs to today.
    expect(reportPeriod({ days: 30, from: '2026-10-10' }, now).to).toBe('2026-10-15');
  });

  it('refuses dates that do not exist and periods that run backwards', () => {
    expect(reportQuerySchema.safeParse({}).success).toBe(true);
    expect(reportQuerySchema.parse({}).days).toBe(30);
    expect(reportQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: '15/10/2026' }).success).toBe(false);
    expect(reportQuerySchema.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ days: '400' }).success).toBe(false);
  });

  it('gives a rate only when there is something to divide', () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 0)).toBeNull();
  });
});

describe('CSV export', () => {
  const row: TicketReportRow = {
    id: 'x',
    reference: 'TMS-7',
    subject: 'Refund, please: "damaged" kettle',
    channel: 'email',
    status: 'Resolved',
    priority: 'normal',
    team: null,
    assignee: 'Maya Lindqvist',
    customer: 'Nora Quist',
    handledBy: 'ai_then_human',
    createdAt: '2026-10-01T10:00:00.000Z',
    firstResponseAt: null,
    resolvedAt: '2026-10-01T11:30:00.000Z',
    firstResponseMinutes: null,
    resolutionMinutes: 90,
    slaState: 'met',
    rating: 4,
  };

  it('quotes commas and quotes, and leaves empty cells empty', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses text a spreadsheet would run as a formula, but not numbers', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvCell('+44 20 7946 0000')).toBe("'+44 20 7946 0000");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-1 item')).toBe("'-1 item");
    expect(csvCell(-5)).toBe('-5');
  });

  it('writes a header and one line per ticket', () => {
    const lines = ticketReportCsv([row]).split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]!.split(',')).toHaveLength(16);
    expect(lines[1]).toBe(
      'TMS-7,"Refund, please: ""damaged"" kettle",email,Resolved,normal,,Maya Lindqvist,Nora Quist,"AI, then a person",2026-10-01T10:00:00.000Z,,2026-10-01T11:30:00.000Z,,90,met,4',
    );
    expect(lines[2]).toBe('');
  });
});

describe('ratings and the portal', () => {
  it('reads a rating from 1 to 5, as a number or text', () => {
    expect(csatSubmitSchema.parse({ rating: '4', comment: '  ' })).toEqual({
      rating: 4,
      comment: undefined,
    });
    expect(csatSubmitSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(csatSubmitSchema.safeParse({ rating: 3.5 }).success).toBe(false);
    expect([isSatisfied(4), isSatisfied(3), isLowRating(2), isLowRating(3)]).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('has sensible defaults for the customer settings', () => {
    expect(customerExperienceSchema.parse({})).toEqual({
      portalEnabled: true,
      csatByEmail: true,
      csatInChat: true,
      agentMinutesPerTicket: 10,
    });
    expect(customerExperienceSchema.safeParse({ agentMinutesPerTicket: 0 }).success).toBe(false);
  });

  it('normalises the sign-in address and refuses empty replies', () => {
    expect(portalSignInSchema.parse({ email: '  Nora@Example.ORG ' }).email).toBe(
      'nora@example.org',
    );
    expect(portalSignInSchema.safeParse({ email: 'nora' }).success).toBe(false);
    expect(portalReplySchema.safeParse({ body: '   ' }).success).toBe(false);
  });

  it('lets team leads export reports, and agents not', () => {
    expect(hasPermission('team_lead', 'report:export')).toBe(true);
    expect(hasPermission('agent', 'report:export')).toBe(false);
    expect(hasPermission('agent', 'report:read')).toBe(false);
  });
});
