import type { AiClassification, AiRunView } from '@tms/shared';
import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Icon, Textarea } from '../../components/ui';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { relativeFromIso } from '../settings/logic';
import styles from './Ai.module.css';
import { classificationText, DECISION_LABELS, percent, ruleLabels } from './logic';

/** The "AI" mark: a sparkle and a label in a rimmed pill. */
export function AiMark({ label = 'AI' }: { label?: string }) {
  return (
    <span className={styles.mark}>
      <Icon name="sparkle" size={12} />
      {label}
    </span>
  );
}

export const aiClass = styles.byAi;
export const aiMetaClass = styles.meta;

/** Review an AI draft: send it as is, edit then send, or discard it. */
export function DraftReview({
  messageId,
  body,
  confidence,
  onChanged,
}: {
  messageId: string;
  body: string;
  confidence: number | null;
  onChanged: () => void | Promise<void>;
}) {
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.draft} role="group" aria-label="AI draft awaiting review">
      <p className={styles.draftLabel}>Draft, not sent yet · confidence {percent(confidence)}</p>
      {editing && (
        <Textarea
          id={`draft-${messageId}`}
          label="Edit the draft"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {error && <p className={styles.meta}>{error}</p>}
      {can('message:approve_draft') && (
        <div className={styles.draftActions}>
          <Button
            size="sm"
            icon="send"
            disabled={busy || !text.trim()}
            onClick={() =>
              void run(() =>
                api(
                  'POST',
                  `/messages/${messageId}/approve`,
                  editing && text !== body ? { body: text.trim() } : {},
                ),
              )
            }
          >
            {editing ? 'Send edited reply' : 'Send draft'}
          </Button>
          {!editing && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => api('POST', `/messages/${messageId}/discard`))}
          >
            Discard
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the classifier suggested for the ticket. */
export function ClassificationChips({ classification }: { classification: AiClassification }) {
  const text = classificationText(classification);
  if (!text) return null;
  return (
    <p className={styles.chips} aria-label="AI classification">
      <AiMark label="Classified" />
      <span>{text}</span>
      <span>· {percent(classification.confidence)} sure</span>
    </p>
  );
}

/** Every AI turn and classification on the ticket, newest first. */
export function AiActivity({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const runs = useGet<AiRunView[]>(`/tickets/${ticketId}/ai-runs?tick=${liveTick}`);
  const [open, setOpen] = useState(false);
  const list = runs.data ?? [];
  if (!list.length) return null;
  return (
    <section className={styles.panel} aria-label="AI activity">
      <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className={styles.summary}>
          AI activity · {list.length} {list.length === 1 ? 'step' : 'steps'}
        </summary>
        {/* Rendered only when opened: the steps quote customer text. */}
        {open && (
          <ol className={styles.runs}>
            {list.map((r) => (
              <li key={r.id} className={styles.run}>
                <span className={styles.runHead}>
                  <span
                    className={cx(styles.glyph, styles[`glyph-${r.decision}`])}
                    aria-hidden="true"
                  />
                  {r.kind === 'classify' ? 'Classified the ticket' : DECISION_LABELS[r.decision]}
                  {r.confidence !== null && <span>· {percent(r.confidence)}</span>}
                  <span>· {relativeFromIso(r.createdAt)}</span>
                </span>
                {ruleLabels(r.rules).length > 0 && <span>{ruleLabels(r.rules).join('; ')}</span>}
                {r.sources.length > 0 && (
                  <span>Sources: {r.sources.map((s) => s.label).join(', ')}</span>
                )}
                {r.tools.length > 0 && (
                  <span>Tools: {r.tools.map((t) => `${t.name} (${t.summary})`).join('; ')}</span>
                )}
                <span>
                  {r.model ?? 'no model'} · {r.promptVersion}
                  {r.error ? ` · ${r.error}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
