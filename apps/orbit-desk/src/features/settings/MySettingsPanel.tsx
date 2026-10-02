import {
  NOTIFICATION_KIND_LABELS,
  NOTIFICATION_KINDS,
  NOTIFICATION_TONE_LABELS,
  NOTIFICATION_TONES,
  type NotificationKind,
  type NotificationTone,
  type UserPreferences,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Select } from '../../components/ui';
import { playTone, PREFERENCES_CHANGED } from '../../lib/sound';
import { useGet } from '../../lib/useGet';
import styles from './Settings.module.css';

/** Settings → My settings: what Orbit Desk does for the signed-in person, starting with sound. */
export function MySettingsPanel() {
  const current = useGet<UserPreferences>('/me/preferences');
  const [form, setForm] = useState<UserPreferences | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (current.data) setForm(current.data);
  }, [current.data]);

  const sound = form?.sound;
  const setSound = (patch: Partial<UserPreferences['sound']>) =>
    form && setForm({ ...form, sound: { ...form.sound, ...patch } });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api<UserPreferences>('PUT', '/me/preferences', form);
      setForm(saved);
      window.dispatchEvent(new CustomEvent(PREFERENCES_CHANGED, { detail: saved }));
      setMessage('Saved.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!sound) return;
    setMessage(
      (await playTone(sound.tone, sound.volume))
        ? null
        : sound.volume <= 0
          ? 'The volume is at zero.'
          : 'This browser did not play the sound. Check that the tab is not muted.',
    );
  };

  return (
    <div className={styles.stack}>
      <Card padding="md">
        <CardHeader
          title="Notification sound"
          subtitle="A short sound when something needs you. Yours alone: it follows you to any browser."
        />
        {current.error && <p className={styles.error}>{current.error}</p>}
        {form && sound && (
          <form className={styles.form} onSubmit={save} aria-label="Notification sound">
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={sound.enabled}
                onChange={(e) => setSound({ enabled: e.target.checked })}
              />
              Play a sound when a notification arrives
            </label>
            <div className={styles.formRow}>
              <Select
                id="sound-tone"
                label="Sound"
                value={sound.tone}
                disabled={!sound.enabled && !sound.newTickets}
                onChange={(e) => setSound({ tone: e.target.value as NotificationTone })}
                options={NOTIFICATION_TONES.map((t) => ({
                  value: t,
                  label: NOTIFICATION_TONE_LABELS[t],
                }))}
              />
              <label className={styles.rangeGroup} htmlFor="sound-volume">
                <span className={styles.rangeLabel}>
                  Volume ({Math.round(sound.volume * 100)}%)
                </span>
                <input
                  id="sound-volume"
                  type="range"
                  className={styles.range}
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(sound.volume * 100)}
                  disabled={!sound.enabled && !sound.newTickets}
                  onChange={(e) => setSound({ volume: Number(e.target.value) / 100 })}
                />
              </label>
            </div>
            <fieldset className={styles.fieldset} disabled={!sound.enabled}>
              <legend className={styles.legend}>Make a sound for</legend>
              {NOTIFICATION_KINDS.map((kind: NotificationKind) => (
                <label key={kind} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={!sound.muted.includes(kind)}
                    onChange={(e) =>
                      setSound({
                        muted: e.target.checked
                          ? sound.muted.filter((k) => k !== kind)
                          : [...sound.muted, kind],
                      })
                    }
                  />
                  {NOTIFICATION_KIND_LABELS[kind]}
                </label>
              ))}
            </fieldset>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={sound.newTickets}
                onChange={(e) => setSound({ newTickets: e.target.checked })}
              />
              Also play a quieter sound whenever a new ticket is opened
            </label>
            <p className={styles.note}>
              A browser stays silent until you have clicked or typed in the tab, and while the tab
              is muted.
            </p>
            {message && (
              <p className={styles.note} role="status">
                {message}
              </p>
            )}
            <div className={styles.formActions}>
              <Button type="button" variant="secondary" onClick={() => void test()}>
                Test sound
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
