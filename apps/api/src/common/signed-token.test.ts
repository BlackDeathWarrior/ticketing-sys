import { describe, expect, it } from 'vitest';
import { surveyMail } from '../csat/csat.handler';
import { readToken, signToken } from './signed-token';

const SECRET = 'a-secret-that-is-long-enough-for-tests-1234';
const ID = '3e0f4a52-6d0e-4c6e-9d6c-0d8f6b5a1c11';

describe('signed link tokens', () => {
  it('give the id back to whoever holds the secret', () => {
    const token = signToken(SECRET, 'csat', ID);
    expect(token.startsWith(`${ID}.`)).toBe(true);
    expect(readToken(SECRET, 'csat', token)).toBe(ID);
  });

  it('are refused when changed, cut short, or made with another secret', () => {
    const token = signToken(SECRET, 'csat', ID);
    expect(readToken(SECRET, 'csat', `${token}x`)).toBeNull();
    expect(readToken(SECRET, 'csat', token.slice(0, -1))).toBeNull();
    expect(readToken(SECRET, 'csat', ID)).toBeNull();
    expect(readToken(SECRET, 'csat', '')).toBeNull();
    expect(readToken(`${SECRET}!`, 'csat', token)).toBeNull();
    // Someone else's ticket id with this ticket's signature.
    const other = '11111111-2222-4333-8444-555555555555';
    expect(readToken(SECRET, 'csat', `${other}.${token.split('.')[1]}`)).toBeNull();
  });

  it('work for one purpose only: a rating link can’t sign anyone in', () => {
    const rating = signToken(SECRET, 'csat', ID);
    expect(readToken(SECRET, 'portal-login', rating)).toBeNull();
    expect(readToken(SECRET, 'portal-login', signToken(SECRET, 'portal-login', ID))).toBe(ID);
  });
});

describe('survey email', () => {
  it('names the request, carries the link and says how to reopen', () => {
    const text = surveyMail({
      name: 'Nora Quist',
      reference: 'TMS-42',
      subject: 'Kettle stopped heating',
      link: 'https://help.example.com/help/#/rate/abc.def',
      team: 'Demo Store Support',
    });
    expect(text).toContain('Hi Nora Quist,');
    expect(text).toContain('TMS-42 ("Kettle stopped heating")');
    expect(text).toContain('\nhttps://help.example.com/help/#/rate/abc.def\n');
    expect(text).toMatch(/reply to our last email/);
    expect(text.endsWith('Demo Store Support')).toBe(true);
  });
});
