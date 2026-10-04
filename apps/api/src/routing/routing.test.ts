import { describe, expect, it } from 'vitest';
import { type Candidate, chooseAgent } from './routing.service';

const agent = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  id,
  name: id,
  status: 'online',
  capacity: 3,
  open: 0,
  lastRoutedAt: null,
  skills: [],
  ...o,
});

describe('chooseAgent', () => {
  it('picks the least loaded online agent with room', () => {
    const team = [
      agent('ana', { open: 2 }),
      agent('ben', { open: 1 }),
      agent('cho', { open: 0, status: 'away' }),
      agent('dev', { open: 3 }),
    ];
    expect(chooseAgent(team, 'least_loaded', null)?.id).toBe('ben');
  });

  it('breaks ties by who waited longest, and takes turns in round robin', () => {
    const team = [
      agent('ana', { lastRoutedAt: new Date('2026-09-30T10:00:00Z') }),
      agent('ben', { lastRoutedAt: new Date('2026-09-30T09:00:00Z') }),
      agent('cho', { lastRoutedAt: null, open: 2 }),
    ];
    expect(chooseAgent(team, 'least_loaded', null)?.id).toBe('ben');
    expect(chooseAgent(team, 'round_robin', null)?.id).toBe('cho');
  });

  it('needs the skill, respects exclusions, and never picks for team_queue', () => {
    const team = [agent('ana'), agent('ben', { skills: ['hindi'] })];
    expect(chooseAgent(team, 'least_loaded', 'hindi')?.id).toBe('ben');
    expect(chooseAgent(team, 'least_loaded', 'hindi', ['ben'])).toBeNull();
    expect(chooseAgent(team, 'team_queue', null)).toBeNull();
    expect(chooseAgent([agent('x', { status: 'offline' })], 'least_loaded', null)).toBeNull();
  });
});
