import type { QueueView, Retention, RetentionCounts, RetentionView } from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Input } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import { relativeFromIso } from '../settings/logic';
import settings from '../settings/Settings.module.css';
import styles from './Admin.module.css';
import { deletedText, RETENTION_FIELDS } from './logic';

/** Settings → System: background jobs that failed for good, and how long data is kept. */
export function SystemPanel() {
  return (
    <div className={settings.stack}>
      <Jobs />
      <RetentionCard />
    </div>
  );
}

function Jobs() {
  const queues = useGet<QueueView[]>('/system/jobs');
  const [error, setError] = useState<string | null>(null);
  const failed = (queues.data ?? []).reduce((n, q) => n + q.failed, 0);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    }
    void queues.reload();
  };

  return (
    <Card padding="md" aria-labelledby="jobs-title">
      <CardHeader
        id="jobs-title"
        title="Background work"
        subtitle={
          queues.data
            ? failed
              ? failed === 1
                ? '1 job has failed after every retry. Retry it once the cause is fixed, or remove it.'
                : `${failed} jobs have failed after every retry. Retry them once the cause is fixed, or remove them.`
              : 'Nothing has failed. Work that fails is retried by itself first.'
            : 'Loading…'
        }
        actions={
          <Button variant="ghost" onClick={() => void queues.reload()} disabled={queues.loading}>
            Refresh
          </Button>
        }
      />
      {(error ?? queues.error) && (
        <p className={settings.error} role="alert">
          {error ?? queues.error}
        </p>
      )}
      <div className={settings.scroller}>
        <table className={settings.table}>
          <thead>
            <tr>
              <th scope="col">Kind of work</th>
              <th scope="col">Failed</th>
              <th scope="col">Waiting</th>
              <th scope="col">Running</th>
              <th scope="col">Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {(queues.data ?? []).map((q) => (
              <tr key={q.name} data-queue={q.name}>
                <td>
                  {q.label}
                  <span className={styles.sub}>{q.name}</span>
                </td>
                <td className="tabular">{q.failed}</td>
                <td className="tabular">{q.waiting}</td>
                <td className="tabular">{q.active}</td>
                <td className="tabular">{q.delayed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(queues.data ?? [])
        .filter((q) => q.jobs.length > 0)
        .map((q) => (
          <section key={q.name} aria-label={`Failed: ${q.label}`} className={styles.failed}>
            <h3 className={styles.failedTitle}>{q.label}</h3>
            <ul className={settings.ruleList}>
              {q.jobs.map((j) => (
                <li key={j.id} className={settings.ruleRow} data-job={j.id}>
                  <div>
                    <p className={settings.ruleName}>{j.reason}</p>
                    <p className={styles.jobDetail}>
                      {[
                        j.about ?? j.name,
                        `${j.attempts} ${j.attempts === 1 ? 'attempt' : 'attempts'}`,
                        j.failedAt ? `failed ${relativeFromIso(j.failedAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <div className={settings.actions}>
                    <Button
                      size="sm"
                      onClick={() =>
                        void act(() => api('POST', `/system/jobs/${q.name}/${j.id}/retry`))
                      }
                    >
                      Retry
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm('Remove this failed job? It will not be tried again.'))
                          void act(() => api('DELETE', `/system/jobs/${q.name}/${j.id}`));
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </Card>
  );
}

function RetentionCard() {
  const view = useGet<RetentionView>('/settings/retention');
  const [form, setForm] = useState<Retention | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (view.data) setForm(view.data.settings);
  }, [view.data]);

  if (!form || !view.data) {
    return view.error ? <p className={settings.error}>{view.error}</p> : null;
  }

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setError(null);
    try {
      await api('PUT', '/settings/retention', form);
      setMessage('Saved.');
      void view.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const run = async () => {
    setRunning(true);
    setMessage(null);
    setError(null);
    try {
      const r = await api<{ deleted: RetentionCounts }>('POST', '/system/retention/run');
      setMessage(`Done: ${deletedText(r.deleted)}.`);
      void view.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const last = view.data.lastRun;
  return (
    <Card padding="md" aria-labelledby="retention-title">
      <CardHeader
        id="retention-title"
        title="Data retention"
        subtitle="Logs and leftovers are deleted once a day when they are older than this. Tickets, messages and the audit log are never deleted."
      />
      <form className={settings.form} onSubmit={save} aria-label="Retention">
        <div className={settings.formRow}>
          {RETENTION_FIELDS.map((f) => (
            <Input
              key={f.key}
              id={`retention-${f.key}`}
              label={f.label}
              type="number"
              min={f.min}
              max={f.max}
              value={String(form[f.key])}
              onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })}
              required
            />
          ))}
        </div>
        <p className={settings.note}>
          Call recordings are kept {view.data.recordingsDays} days. That is fixed, because the call
          page tells callers so.
        </p>
        <p className={settings.note} data-last-run>
          {last
            ? `Last run ${relativeFromIso(last.at)}: ${deletedText(last.deleted)}.`
            : 'Retention has not run yet.'}
        </p>
        {error && (
          <p className={settings.error} role="alert">
            {error}
          </p>
        )}
        <div className={settings.formActions}>
          {message && (
            <p className={settings.note} role="status">
              {message}
            </p>
          )}
          <Button onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Run now'}
          </Button>
          <Button type="submit">Save retention</Button>
        </div>
      </form>
    </Card>
  );
}
