import type { ChannelHealth, HealthChannel } from '@tms/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, StatusLight } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import { activityLine, overallLine, relativeFromIso } from './logic';
import styles from './Settings.module.css';

const REFRESH_MS = 30_000;

/** The channel lights, refreshed every 30 seconds while the page is open. */
export function useChannelHealth() {
  const health = useGet<ChannelHealth[]>('/channels/health');
  const { reload } = health;
  const [fresh, setFresh] = useState<ChannelHealth[] | undefined>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const timer = setInterval(() => {
      setFresh(undefined);
      void reload();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  /** Tries the mail server and Meta right now. */
  const check = useCallback(async () => {
    setChecking(true);
    setError(undefined);
    try {
      setFresh(await api<ChannelHealth[]>('POST', '/channels/health/check'));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setFresh(undefined);
    await reload();
  }, [reload]);

  return { data: fresh ?? health.data, error: error ?? health.error, checking, check, refresh };
}

/** The id of a channel's card, so the overview tiles can scroll to it. */
export const cardId = (channel: HealthChannel) => `channel-card-${channel}`;

/** Every channel's light on one card, so a problem is visible before scrolling. */
export function HealthOverview({
  health,
  checking,
  onCheck,
}: {
  health: ChannelHealth[];
  checking: boolean;
  onCheck: () => void;
}) {
  const checked = health
    .map((h) => h.checkedAt)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
  return (
    <Card padding="md" aria-labelledby="channel-status">
      <CardHeader
        id="channel-status"
        title="Channel status"
        subtitle={overallLine(health)}
        actions={
          <Button onClick={onCheck} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        }
      />
      <ul className={styles.lights} aria-label="Channels">
        {health.map((h) => (
          <li key={h.channel}>
            {/* A button, not a link: the page's address is the app's route (#/settings/…). */}
            <button
              type="button"
              className={styles.lightTile}
              data-state={h.state}
              onClick={() =>
                document
                  .getElementById(cardId(h.channel))
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              <span className={styles.lightName}>{h.label}</span>
              <StatusLight state={h.state} />
              <span className={styles.lightSummary}>{h.summary}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        Green: working. Amber: working, but something needs a look. Red: not working. Grey: off.
        {checked ? ` Connections last checked ${relativeFromIso(checked)}.` : ''}
      </p>
    </Card>
  );
}

/** The light with its one-line explanation: "Connected to +1 555 … (Demo Store)". */
export function HealthBanner({ health }: { health: ChannelHealth }) {
  return (
    <p className={styles.banner} data-state={health.state} role="status">
      <StatusLight state={health.state} />
      <span>{health.summary}</span>
    </p>
  );
}

/** What was checked for one channel, each line with its own light and the reason. */
export function HealthChecks({ health }: { health: ChannelHealth }) {
  const activity = activityLine(health.activity);
  if (!health.checks.length && !activity) return null;
  return (
    <div className={styles.checks}>
      <ul className={styles.checkList} aria-label={`${health.label} checks`}>
        {health.checks.map((c) => (
          <li key={c.key} className={styles.check} data-state={c.state}>
            <StatusLight state={c.state} compact />
            <span className={styles.checkLabel}>{c.label}</span>
            <span className={styles.checkDetail}>{c.detail}</span>
          </li>
        ))}
      </ul>
      {activity && <p className={styles.note}>{activity}</p>}
    </div>
  );
}

/** A channel with nothing to configure: its light and its checks. */
export function HealthCard({ health, subtitle }: { health: ChannelHealth; subtitle: string }) {
  return (
    <Card padding="md" id={cardId(health.channel)} aria-labelledby={`${cardId(health.channel)}-h`}>
      <CardHeader
        id={`${cardId(health.channel)}-h`}
        title={health.label}
        subtitle={subtitle}
        actions={<StatusLight state={health.state} />}
      />
      <HealthChecks health={health} />
    </Card>
  );
}
