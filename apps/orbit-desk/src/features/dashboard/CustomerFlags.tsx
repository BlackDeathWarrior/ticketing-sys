import { CUSTOMER_FLAG_LABELS, type CustomerFlagView } from '@tms/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Icon, Input } from '../../components/ui';
import { minutesSince } from '../../data/adapters';
import { relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import styles from './CustomerFlags.module.css';

/**
 * Flags the AI put on a customer when it closed a conversation for misuse
 * (an attempt to override its instructions, abuse, spam). While a flag is
 * recent the AI gives that customer no second warning. Clearing one needs a
 * note saying why; the flag stays in the customer's history.
 */
export function CustomerFlags({ customerId, liveTick }: { customerId: string; liveTick: number }) {
  const { can } = useSession();
  const customer = useGet<{ flags?: CustomerFlagView[] }>(
    can('customer:read') ? `/customers/${customerId}` : null,
  );
  const reload = customer.reload;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);
  const [clearing, setClearing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const active = (customer.data?.flags ?? []).filter((f) => !f.clearedAt);
  if (!active.length) return null;

  const clear = async (flagId: string) => {
    setError(null);
    try {
      await api('POST', `/customers/${customerId}/flags/${flagId}/clear`, { note: note.trim() });
      setClearing(null);
      setNote('');
      void reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className={styles.flags} role="group" aria-label="Customer flags">
      {active.map((f) => (
        <div key={f.id} className={styles.flag} data-flag={f.kind}>
          <p className={styles.line}>
            <Icon name="alert" size={14} />
            <span>
              Flagged by the AI: {CUSTOMER_FLAG_LABELS[f.kind]} ·{' '}
              {relativeTime(minutesSince(new Date(f.createdAt)))}
            </span>
          </p>
          {can('customer:write') &&
            (clearing === f.id ? (
              <div className={styles.clear}>
                <Input
                  id={`clear-${f.id}`}
                  label="Why the flag no longer applies"
                  value={note}
                  maxLength={500}
                  onChange={(e) => setNote(e.target.value)}
                />
                <div className={styles.buttons}>
                  <Button size="sm" variant="ghost" onClick={() => setClearing(null)}>
                    Back
                  </Button>
                  <Button
                    size="sm"
                    disabled={note.trim().length < 3}
                    onClick={() => void clear(f.id)}
                  >
                    Clear flag
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNote('');
                  setClearing(f.id);
                }}
              >
                Clear flag…
              </Button>
            ))}
        </div>
      ))}
      {error && (
        <p className={styles.line} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
