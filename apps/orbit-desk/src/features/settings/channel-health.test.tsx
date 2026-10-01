import type { ChannelHealth, HealthState } from '@tms/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusLight } from '../../components/ui';
import { HealthCard, HealthChecks, HealthOverview } from './ChannelHealth';
import { activityLine, newVerifyToken, overallLine } from './logic';

const channel = (
  label: string,
  state: HealthState,
  over: Partial<ChannelHealth> = {},
): ChannelHealth => ({
  channel: 'email',
  label,
  state,
  summary: `${label} summary`,
  checks: [],
  activity: { lastInboundAt: null, lastOutboundAt: null, failed24h: 0, lastFailure: null },
  checkedAt: null,
  ...over,
});

describe('channel status wording', () => {
  it('names what is broken first, then what needs attention', () => {
    expect(
      overallLine([
        channel('Email', 'down'),
        channel('WhatsApp', 'warning'),
        channel('Web chat', 'ok'),
      ]),
    ).toBe('Email is not working.');
    expect(overallLine([channel('Email', 'down'), channel('WhatsApp', 'down')])).toBe(
      'Email and WhatsApp are not working.',
    );
    expect(overallLine([channel('Email', 'ok'), channel('WhatsApp', 'warning')])).toBe(
      'WhatsApp needs attention.',
    );
  });

  it('says so when everything that is on works, or nothing is on', () => {
    expect(overallLine([channel('Email', 'ok'), channel('Voice', 'off')])).toBe(
      'Every channel that is switched on is working.',
    );
    expect(overallLine([channel('Voice', 'off')])).toBe('No channel is switched on yet.');
  });

  it('describes recent traffic, or nothing for a quiet channel', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(
      activityLine(
        {
          lastInboundAt: '2026-10-01T11:55:00Z',
          lastOutboundAt: '2026-10-01T10:00:00Z',
          failed24h: 0,
          lastFailure: null,
        },
        now,
      ),
    ).toBe('Last message received 5m ago · last sent 2h ago');
    expect(
      activityLine({ lastInboundAt: null, lastOutboundAt: null, failed24h: 0, lastFailure: null }),
    ).toBe('');
  });

  it('makes a long random verify token each time', () => {
    const a = newVerifyToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(newVerifyToken()).not.toBe(a);
  });
});

describe('status light', () => {
  it('always says its state in words, even when only the dot shows', () => {
    const { rerender, container } = render(<StatusLight state="ok" />);
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('data-state', 'ok');

    rerender(<StatusLight state="down" compact />);
    expect(screen.getByText('Not working')).toHaveClass('visually-hidden');
    rerender(<StatusLight state="warning" label="Token expires soon" />);
    expect(screen.getByText('Token expires soon')).toBeInTheDocument();
  });
});

describe('channel status cards', () => {
  const email = channel('Email', 'down', {
    summary: 'Invalid login',
    checkedAt: new Date().toISOString(),
    checks: [
      {
        key: 'imap',
        label: 'Reading the mailbox',
        state: 'ok',
        detail: 'Watching support@tms.example',
      },
      { key: 'smtp', label: 'Sending email', state: 'down', detail: 'Invalid login' },
    ],
  });
  const chat = channel('Web chat', 'ok', { channel: 'webchat', summary: 'Accepting chats' });

  it('shows every channel with its light and summary, and when it was checked', () => {
    render(<HealthOverview health={[email, chat]} checking={false} onCheck={() => undefined} />);
    const list = screen.getByRole('list', { name: 'Channels' });
    const tiles = within(list).getAllByRole('button');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveAttribute('data-state', 'down');
    expect(tiles[0]).toHaveTextContent('Not working');
    expect(tiles[0]).toHaveTextContent('Invalid login');
    expect(tiles[1]).toHaveTextContent('Working');
    expect(screen.getByText('Email is not working.')).toBeInTheDocument();
    expect(screen.getByText(/Connections last checked just now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled();
  });

  it('lists each check with its own state and the reason', () => {
    render(<HealthChecks health={email} />);
    const rows = within(screen.getByRole('list', { name: 'Email checks' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['ok', 'down']);
    expect(rows[1]).toHaveTextContent('Sending email');
    expect(rows[1]).toHaveTextContent('Invalid login');
  });

  it('renders a card for a channel with nothing to configure', () => {
    render(<HealthCard health={chat} subtitle="The chat widget on your website." />);
    const card = screen.getByRole('region', { name: 'Web chat' });
    expect(card).toHaveAttribute('id', 'channel-card-webchat');
    expect(within(card).getByText('Working')).toBeInTheDocument();
  });
});
