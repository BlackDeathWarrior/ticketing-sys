import type {
  ChannelActivity,
  ChannelHealth,
  HealthState,
  LlmRoleCandidate,
  Permission,
} from '@tms/shared';

export type SettingsTab =
  | 'providers'
  | 'models'
  | 'ai'
  | 'channels'
  | 'customers'
  | 'tools'
  | 'routing'
  | 'sla'
  | 'tickets'
  | 'people'
  | 'usage'
  | 'system';

export const SETTINGS_TABS: Array<{
  value: SettingsTab;
  label: string;
  needs: Permission[];
  /** Any one of these also opens the tab (it then shows only what that permission covers). */
  anyOf?: Permission[];
}> = [
  { value: 'providers', label: 'AI providers', needs: ['settings:llm'] },
  { value: 'models', label: 'Models & roles', needs: ['settings:llm'] },
  { value: 'ai', label: 'AI behaviour', needs: ['settings:ai'] },
  { value: 'channels', label: 'Channels', needs: ['settings:channels'] },
  { value: 'customers', label: 'Customers', needs: ['settings:channels'] },
  { value: 'tools', label: 'Tools & MCP', needs: ['tool:manage'], anyOf: ['tool:create'] },
  { value: 'routing', label: 'Routing', needs: ['settings:routing'] },
  { value: 'sla', label: 'SLA', needs: ['settings:sla'] },
  {
    value: 'tickets',
    label: 'Tickets',
    needs: ['settings:categories', 'settings:workflow'],
    anyOf: ['settings:categories', 'settings:workflow'],
  },
  { value: 'people', label: 'People', needs: ['user:manage'] },
  { value: 'usage', label: 'Usage', needs: ['settings:llm'] },
  { value: 'system', label: 'System', needs: ['system:manage'] },
];

/** Tabs the user may open, in display order. */
export function visibleTabs(can: (p: Permission) => boolean) {
  return SETTINGS_TABS.filter((t) => t.needs.every(can) || !!t.anyOf?.some(can));
}

/** Whether the Settings link should show at all. */
export const canOpenSettings = (can: (p: Permission) => boolean) => visibleTabs(can).length > 0;

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0';
  if (value < 0.0001) return '<$0.0001';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** Per-million-token price as providers publish it. */
export function formatPerMTok(value: number | null): string {
  if (value === null) return 'unknown';
  return `$${value < 1 ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : value.toFixed(2)}`;
}

export function maskedKey(last4: string | null, set = true): string {
  if (!set) return 'Not set';
  return last4 ? `••••${last4}` : '••••';
}

const SKIP_LABELS: Record<NonNullable<LlmRoleCandidate['skipped']>, string> = {
  provider_disabled: 'provider off',
  model_disabled: 'model off',
  over_budget: 'over budget',
  missing_capability: 'lacks a needed capability',
};

export const skipLabel = (reason: LlmRoleCandidate['skipped']) =>
  reason ? SKIP_LABELS[reason] : '';

export const PERIOD_LABELS = { day: 'per day', week: 'per week', month: 'per month' } as const;

/** Parses a dollar amount typed in a form; empty means "no cap". */
export function parseBudget(text: string): number | null | 'invalid' {
  const t = text.trim().replace(/^\$/, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : 'invalid';
}

export function relativeFromIso(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Moves `ids[index]` one step up (-1) or down (+1). */
export function move<T>(list: T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

// ---- Channel status lights ----

/** "Last message in 5m ago · last sent 2h ago", or nothing when the channel has been quiet. */
export function activityLine(a: ChannelActivity, now = Date.now()): string {
  return [
    a.lastInboundAt ? `Last message received ${relativeFromIso(a.lastInboundAt, now)}` : null,
    a.lastOutboundAt ? `last sent ${relativeFromIso(a.lastOutboundAt, now)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One sentence for all channels: what is broken first, then what needs a look. */
export function overallLine(health: Array<Pick<ChannelHealth, 'label' | 'state'>>): string {
  const names = (state: HealthState) => health.filter((h) => h.state === state).map((h) => h.label);
  const list = (items: string[]) =>
    items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? '');
  const down = names('down');
  const warning = names('warning');
  const on = health.filter((h) => h.state !== 'off').length;
  if (down.length) {
    return `${list(down)} ${down.length === 1 ? 'is' : 'are'} not working.`;
  }
  if (warning.length) {
    return `${list(warning)} ${warning.length === 1 ? 'needs' : 'need'} attention.`;
  }
  return on ? 'Every channel that is switched on is working.' : 'No channel is switched on yet.';
}

/** A random webhook verify token: any long string works, as long as Meta gets the same one. */
export function newVerifyToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
