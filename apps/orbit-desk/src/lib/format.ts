export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function relativeTime(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function duration(minutes: number): string {
  const m = Math.abs(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h}h ${rest}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export type SlaState = 'breached' | 'at-risk' | 'on-track' | 'done';

export function slaState(minutes: number | null): SlaState {
  if (minutes === null) return 'done';
  if (minutes < 0) return 'breached';
  if (minutes <= 60) return 'at-risk';
  return 'on-track';
}

export function slaLabel(minutes: number | null): string {
  if (minutes === null) return 'Met';
  if (minutes < 0) return `${duration(minutes)} over`;
  return `${duration(minutes)} left`;
}

/** A file size for people: 900 B, 12 KB, 1.4 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}
