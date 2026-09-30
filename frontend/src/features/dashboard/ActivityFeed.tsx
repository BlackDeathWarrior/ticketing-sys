import { activity } from '../../data/mock';
import { relativeTime } from '../../lib/format';
import { Avatar, Card, CardHeader } from '../../components/ui';
import styles from './ActivityFeed.module.css';

export function ActivityFeed({ onOpen }: { onOpen: (id: string) => void }) {
  return (
    <Card aria-labelledby="activity-title">
      <CardHeader id="activity-title" title="Activity" subtitle="Across all teams, live" />
      <ol className={styles.feed}>
        {activity.map((e) => (
          <li key={e.id} className={styles.event}>
            <Avatar initials={e.initials} size={28} highlight={e.initials === 'AI'} />
            <p className={styles.text}>
              <span className={styles.actor}>{e.actor}</span> {e.action}{' '}
              <button type="button" className={styles.target} onClick={() => onOpen(e.target)}>
                {e.target}
              </button>
            </p>
            <time className={styles.time}>{relativeTime(e.minutesAgo)}</time>
          </li>
        ))}
      </ol>
    </Card>
  );
}
