import type { StatusCategory } from '@tms/shared';

export interface StatusRow {
  key: string;
  name: string;
  category: string;
  isActive: boolean;
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: 'same_status' | 'unknown_status' | 'inactive_status' | 'not_allowed' };

/** Pure transition check, kept separate from the DB so it is easy to unit test. */
export function checkTransition(
  statuses: StatusRow[],
  transitions: Array<{ fromStatus: string; toStatus: string }>,
  from: string,
  to: string,
): TransitionCheck {
  if (from === to) return { ok: false, reason: 'same_status' };
  const target = statuses.find((s) => s.key === to);
  if (!target) return { ok: false, reason: 'unknown_status' };
  if (!target.isActive) return { ok: false, reason: 'inactive_status' };
  const allowed = transitions.some((t) => t.fromStatus === from && t.toStatus === to);
  return allowed ? { ok: true } : { ok: false, reason: 'not_allowed' };
}

/** Timestamp columns to set or clear when a ticket enters a status of the given category. */
export function lifecycleTimestamps(category: StatusCategory | string, now: Date) {
  switch (category) {
    case 'resolved':
      return { resolvedAt: now, closedAt: null };
    case 'closed':
      return { closedAt: now };
    default:
      // Reopened: clear both so reporting doesn't count the old resolution.
      return { resolvedAt: null, closedAt: null };
  }
}
