import { describe, expect, it } from 'vitest';
import { canActOnTeam, canDecideApproval, isTeamAdmin } from './auth';

const ORDERS = 'team-orders';
const PAYMENTS = 'team-payments';

const member = {
  permissions: ['ticket:read', 'ticket:reply'],
  teams: [{ id: ORDERS, role: 'member' as const }],
};
const teamAdmin = { permissions: ['ticket:read'], teams: [{ id: ORDERS, role: 'admin' as const }] };
const supervisor = { permissions: ['ticket:read', 'approval:approve'], teams: [] };
const superAdmin = { permissions: ['ticket:any_team', 'team:manage'], teams: [] };
const noTeams = { permissions: ['ticket:read'] };

describe('acting on a ticket (ADR 0031)', () => {
  it('lets a member act on their own team’s ticket and not on another team’s', () => {
    expect(canActOnTeam(member, ORDERS)).toBe(true);
    expect(canActOnTeam(member, PAYMENTS)).toBe(false);
  });

  it('leaves a ticket with no team open to everyone', () => {
    expect(canActOnTeam(noTeams, null)).toBe(true);
    expect(canActOnTeam(noTeams, undefined)).toBe(true);
  });

  it('lets a super admin act on any team’s ticket', () => {
    expect(canActOnTeam(superAdmin, PAYMENTS)).toBe(true);
  });

  it('refuses someone on no team', () => {
    expect(canActOnTeam(noTeams, ORDERS)).toBe(false);
  });
});

describe('deciding an approval (ADR 0031)', () => {
  it('belongs to the approving team: a member decides without the permission', () => {
    expect(canDecideApproval(member, ORDERS)).toBe(true);
  });

  it('is refused to a supervisor who is not on the approving team', () => {
    expect(canDecideApproval(supervisor, PAYMENTS)).toBe(false);
  });

  it('falls to holders of approval:approve when the request has no team', () => {
    expect(canDecideApproval(supervisor, null)).toBe(true);
    expect(canDecideApproval(member, null)).toBe(false);
  });

  it('is always open to a super admin', () => {
    expect(canDecideApproval(superAdmin, PAYMENTS)).toBe(true);
    expect(canDecideApproval(superAdmin, null)).toBe(true);
  });
});

describe('managing a team’s members', () => {
  it('is for that team’s admins, not its members or another team’s admins', () => {
    expect(isTeamAdmin(teamAdmin, ORDERS)).toBe(true);
    expect(isTeamAdmin(member, ORDERS)).toBe(false);
    expect(isTeamAdmin(teamAdmin, PAYMENTS)).toBe(false);
  });

  it('is open to whoever may manage every team', () => {
    expect(isTeamAdmin(superAdmin, PAYMENTS)).toBe(true);
  });
});
