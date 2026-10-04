import type { ActivityEvent } from '@tms/shared';
import { initials, minutesSince } from '../../data/adapters';
import { cx, relativeTime } from '../../lib/format';
import { aiClass, AiMark } from '../ai/AiParts';
import { Avatar, Card, CardHeader } from '../../components/ui';
import { describeActivity } from './logic';
import styles from './ActivityFeed.module.css';

export function ActivityFeed({
  events,
  onOpen,
}: {
  events: ActivityEvent[];
  onOpen: (ticketId: string) => void;
}) {
  return (
    <Card aria-labelledby="activity-title">
      <CardHeader id="activity-title" title="Activity" subtitle="Latest ticket changes, live" />
      {events.length === 0 ? (
        <p className={styles.text}>No ticket activity yet.</p>
      ) : (
        <ol className={styles.feed}>
          {events.map((e) => {
            const { actor, action } = describeActivity(e);
            return (
              <li
                key={e.id}
                className={cx(styles.event, e.actor.type === 'ai' && aiClass)}
                data-ai={e.actor.type === 'ai' || undefined}
              >
                <Avatar
                  initials={e.actor.type === 'ai' ? 'AI' : initials(actor)}
                  size={28}
                  highlight={e.actor.type === 'ai'}
                />
                <p className={styles.text}>
                  <span className={styles.actor}>{actor}</span>
                  {e.actor.type === 'ai' && (
                    <>
                      {' '}
                      <AiMark />
                    </>
                  )}{' '}
                  {action}{' '}
                  {e.ticket && (
                    <button
                      type="button"
                      className={styles.target}
                      onClick={() => onOpen(e.ticket!.id)}
                      title={e.ticket.subject}
                    >
                      {e.ticket.reference}
                    </button>
                  )}
                </p>
                <time className={styles.time} dateTime={e.occurredAt}>
                  {relativeTime(minutesSince(new Date(e.occurredAt)))}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
