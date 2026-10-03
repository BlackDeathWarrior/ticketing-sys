import type { ToolHelperAnswer, ToolHelperTurn } from '@tms/shared';
import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Textarea } from '../../components/ui';
import { AiMark } from '../ai/AiParts';
import settings from '../settings/Settings.module.css';
import styles from './Tools.module.css';

/** The helper keeps this many turns of the exchange; older ones are already in the form. */
const MAX_TURNS = 12;

/**
 * The AI helper beside a tool or MCP server form (ADR 0036). A person says
 * what they want in their own words; the answer fills in the form through
 * `onDraft`, and says what is still needed. It saves nothing: the form below
 * is checked and saved by the person.
 */
export function ToolHelper<Draft>({
  id,
  path,
  draft,
  onDraft,
  placeholder,
}: {
  id: string;
  /** The helper's route for this form. */
  path: string;
  /** The form as it stands, so a second description changes it instead of starting again. */
  draft: Draft;
  onDraft: (draft: Draft) => void;
  placeholder: string;
}) {
  const [turns, setTurns] = useState<ToolHelperTurn[]>([]);
  const [text, setText] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = async () => {
    const said = text.trim();
    if (!said || busy) return;
    const next = [...turns, { from: 'you' as const, text: said }].slice(-MAX_TURNS);
    setBusy(true);
    setError(null);
    try {
      const answer = await api<ToolHelperAnswer<Draft>>('POST', path, { messages: next, draft });
      onDraft(answer.draft);
      setTurns([...next, { from: 'helper' as const, text: answer.message }].slice(-MAX_TURNS));
      setMissing(answer.missing);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.helper} aria-label="AI helper">
      <p className={styles.helperTitle}>
        <AiMark label="AI helper" />
      </p>
      <p className={settings.note}>
        Say what you want in your own words and the helper fills in the form below. Check it before
        you save. Never paste a key or a password here.
      </p>
      {turns.length > 0 && (
        <ol className={styles.helperTurns} aria-label="What was said">
          {turns.map((t, i) => (
            <li key={i} className={styles.helperTurn} data-from={t.from}>
              <span className={styles.helperWho}>{t.from === 'you' ? 'You' : 'Helper'}</span>
              {t.text}
            </li>
          ))}
        </ol>
      )}
      {missing.length > 0 && (
        <div role="status">
          <p className={styles.helperWho}>Still needed</p>
          <ul className={styles.helperMissing}>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <Textarea
        id={id}
        label={turns.length ? 'Answer, or say what to change' : 'What should it do?'}
        rows={3}
        maxLength={4000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
      />
      <div>
        <Button size="sm" onClick={() => void ask()} disabled={busy || !text.trim()}>
          {busy ? 'Working on it…' : turns.length ? 'Update the form' : 'Fill in the form'}
        </Button>
      </div>
      {error && <p className={settings.error}>{error}</p>}
    </section>
  );
}
