import {
  DEFAULT_USER_PREFERENCES,
  type NotificationView,
  type PresenceStatus,
  type UserPreferences,
} from '@tms/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useAgentEvents } from '../../api/realtime';
import { minutesSince } from '../../data/adapters';
import { cx, relativeTime } from '../../lib/format';
import { armSound, playTone, PREFERENCES_CHANGED } from '../../lib/sound';
import { useGet } from '../../lib/useGet';
import { Icon } from '../ui';
import styles from './Notifications.module.css';

/** The bell: this agent's notifications, live, with a count of unread ones. */
export function NotificationBell({ onOpenTicket }: { onOpenTicket: (ticketId: string) => void }) {
  const [open, setOpen] = useState(false);
  const list = useGet<{ unread: number; items: NotificationView[] }>('/notifications?limit=20');
  const reload = list.reload;
  const panel = useRef<HTMLDivElement>(null);

  // The person's own sound settings; saved ones arrive from the settings page without a reload.
  const stored = useGet<UserPreferences>('/me/preferences');
  const sound = useRef(DEFAULT_USER_PREFERENCES.sound);
  if (stored.data) sound.current = stored.data.sound;
  useEffect(() => {
    armSound();
    const onSaved = (e: Event) => {
      sound.current = (e as CustomEvent<UserPreferences>).detail.sound;
    };
    window.addEventListener(PREFERENCES_CHANGED, onSaved);
    return () => window.removeEventListener(PREFERENCES_CHANGED, onSaved);
  }, []);

  useAgentEvents((events) => {
    if (events.some((e) => e.type === 'notification.created' || e.type === 'live.resumed'))
      void reload();
    // A new ticket for anyone: quieter than a notification meant for this person.
    else if (sound.current.newTickets && events.some((e) => e.type === 'ticket.created'))
      void playTone(sound.current.tone, sound.current.volume * 0.5);
  });

  // A sound for notifications that were not there the last time the list loaded.
  // The first load only takes stock: nothing rings for what arrived while away.
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items = list.data?.items;
    if (!items) return;
    const fresh = known.current ? items.filter((n) => !n.readAt && !known.current!.has(n.id)) : [];
    known.current = new Set(items.map((n) => n.id));
    const s = sound.current;
    if (s.enabled && fresh.some((n) => !s.muted.includes(n.kind))) void playTone(s.tone, s.volume);
  }, [list.data]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const unread = list.data?.unread ?? 0;
  const openItem = async (n: NotificationView) => {
    if (!n.readAt) await api('POST', `/notifications/${n.id}/read`).catch(() => undefined);
    setOpen(false);
    void reload();
    if (n.ticket) onOpenTicket(n.ticket.id);
  };

  return (
    <div className={styles.wrap} ref={panel}>
      <button
        type="button"
        className={styles.bell}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls="notification-panel"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className={cx(styles.count, 'tabular')} aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className={styles.panel}
          id="notification-panel"
          role="dialog"
          aria-label="Notifications"
        >
          <div className={styles.head}>
            <span>Notifications</span>
            {unread > 0 && (
              <button
                type="button"
                className={styles.link}
                onClick={() => void api('POST', '/notifications/read-all').then(() => reload())}
              >
                Mark all read
              </button>
            )}
          </div>
          {list.data?.items.length ? (
            <ul className={styles.list}>
              {list.data.items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cx(styles.item, !n.readAt && styles.unread)}
                    onClick={() => void openItem(n)}
                    data-kind={n.kind}
                  >
                    <span className={styles.title}>{n.title}</span>
                    {n.body && <span className={styles.body}>{n.body}</span>}
                    <time className={styles.time} dateTime={n.createdAt}>
                      {relativeTime(minutesSince(new Date(n.createdAt)))}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>Nothing new.</p>
          )}
        </div>
      )}
    </div>
  );
}

const PRESENCE_LABELS: Record<PresenceStatus, string> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

/** Online agents get routed tickets; away and offline ones don't. */
export function PresenceSwitch() {
  const me = useGet<{ status: PresenceStatus; capacity: number }>('/me/presence');
  const [busy, setBusy] = useState(false);
  const status = me.data?.status ?? 'offline';
  return (
    <label className={styles.presence} data-presence={status}>
      <span className={cx(styles.dot, styles[status])} aria-hidden="true" />
      <span className="visually-hidden">Your status</span>
      <select
        className={styles.select}
        value={status}
        disabled={busy || !me.data}
        onChange={async (e) => {
          setBusy(true);
          await api('PUT', '/me/presence', { status: e.target.value }).catch(() => undefined);
          await me.reload();
          setBusy(false);
        }}
      >
        {(Object.keys(PRESENCE_LABELS) as PresenceStatus[]).map((s) => (
          <option key={s} value={s}>
            {PRESENCE_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );
}
