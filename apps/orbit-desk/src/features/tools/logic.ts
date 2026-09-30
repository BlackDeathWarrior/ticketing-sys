import {
  type ApprovalStatus,
  describeArgs,
  type ToolCallStatus,
  TOOL_TIER_LABELS,
  type ToolTier,
} from '@tms/shared';

export const tierLabel = (tier: ToolTier) => TOOL_TIER_LABELS[tier];

export const CALL_STATUS_LABELS: Record<ToolCallStatus, string> = {
  ok: 'Done',
  error: 'Failed',
  denied: 'Refused',
  awaiting_approval: 'Waiting for approval',
  approved: 'Approved, running',
  running: 'Running',
  rejected: 'Not approved',
  expired: 'Expired',
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** Arguments to show a person: the customer binding is shown separately, as "Customer". */
export function argRows(args: Record<string, unknown>, hide: string[] = []) {
  return Object.entries(args)
    .filter(([k, v]) => !hide.includes(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ({
      label: k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      value: typeof v === 'object' ? JSON.stringify(v) : String(v),
    }));
}

export const argsLine = (args: Record<string, unknown>, hide: string[] = []) =>
  describeArgs(args, hide);

/** Property names a tool takes, for the "customer argument" choice. */
export function schemaArgs(schema: Record<string, unknown>): string[] {
  const props = schema.properties;
  return props && typeof props === 'object' ? Object.keys(props) : [];
}

/** "in 3 h", "in 12 min", "expired". */
export function timeLeft(expiresAt: string, now = new Date()): string {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${Math.max(1, min)} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

/** A tool's result, short enough for a card. */
export function resultPreview(result: unknown, max = 240): string {
  if (result === null || result === undefined) return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Parses the JSON typed into the test dialog; an error message when it isn't an object. */
export function parseArgs(
  text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, error: 'Arguments must be a JSON object, like {"order_id": "DS-10421"}' };
    }
    return { ok: true, value: v as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'That is not valid JSON' };
  }
}
