import type {
  ConnectionCheck,
  ConnectionDiagnosis,
  ToolHelperAnswer,
  ToolHelperTurn,
} from '@tms/shared';
import { useState } from 'react';
import { api } from '../../api/client';
import { Button, StatusLight, Textarea } from '../../components/ui';
import { AiMark } from '../ai/AiParts';
import settings from '../settings/Settings.module.css';
import styles from './Tools.module.css';

/** The helper keeps this many turns of the exchange; older ones are already in the form. */
const MAX_TURNS = 12;

/** What "Check connection" needs from the form beside it. */
export interface HelperConnection {
  checkPath: string;
  diagnosePath: string;
  /** The form's title or name: it tells one saved bug from another. */
  name: string;
  method?: string;
  url: string;
  /** What the check route takes: the address, the key header and the saved tool or server. */
  body: Record<string, unknown>;
}

/**
 * The AI helper beside a tool or MCP server form (ADR 0036). A person says
 * what they want in their own words; the answer fills in the form through
 * `onDraft`, and says what is still needed. It saves nothing: the form below
 * is checked and saved by the person. Next to it, the connection in the form
 * can be checked, and a failed check explained and saved as a bug.
 */
export function ToolHelper<Draft>({
  id,
  path,
  draft,
  onDraft,
  placeholder,
  connection,
}: {
  id: string;
  /** The helper's route for this form. */
  path: string;
  /** The form as it stands, so a second description changes it instead of starting again. */
  draft: Draft;
  onDraft: (draft: Draft) => void;
  placeholder: string;
  connection: HelperConnection;
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
      <ConnectionCheckRow connection={connection} />
    </section>
  );
}

/**
 * "Check connection": asks the desk whether the address in the form answers,
 * without changing anything in the other system. When it does not, "Diagnose
 * with AI" explains why in plain words, and the failure is saved as a ticket
 * (tag `tool-bug`) so someone can follow it up.
 */
function ConnectionCheckRow({ connection }: { connection: HelperConnection }) {
  const [busy, setBusy] = useState<'check' | 'diagnose' | null>(null);
  const [checked, setChecked] = useState<{ url: string; result: ConnectionCheck } | null>(null);
  const [diagnosis, setDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A result is about the address it was run for; once the address changes it no longer applies.
  const result = checked && checked.url === connection.url ? checked.result : null;

  const check = async () => {
    setBusy('check');
    setError(null);
    setDiagnosis(null);
    try {
      const r = await api<ConnectionCheck>('POST', connection.checkPath, connection.body);
      setChecked({ url: connection.url, result: r });
    } catch (err) {
      setChecked(null);
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const diagnose = async () => {
    if (!result) return;
    setBusy('diagnose');
    setError(null);
    try {
      setDiagnosis(
        await api<ConnectionDiagnosis>('POST', connection.diagnosePath, {
          name: connection.name,
          ...(connection.method ? { method: connection.method } : {}),
          url: connection.url,
          check: {
            ok: result.ok,
            summary: result.summary,
            status: result.status,
            detail: result.detail,
            ms: result.ms,
          },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.helperCheck}>
      <div className={styles.helperActions}>
        <Button size="sm" onClick={() => void check()} disabled={!!busy || !connection.url}>
          {busy === 'check' ? 'Checking…' : 'Check connection'}
        </Button>
        {result && !result.ok && (
          <Button size="sm" onClick={() => void diagnose()} disabled={!!busy}>
            {busy === 'diagnose' ? 'Looking into it…' : 'Diagnose with AI'}
          </Button>
        )}
        {!connection.url && <span className={settings.note}>Fill in the address first.</span>}
      </div>
      {result && (
        <div role="status" data-check={result.ok ? 'ok' : 'failed'}>
          <StatusLight
            state={result.ok ? 'ok' : 'down'}
            label={result.ok ? 'Connected' : 'Not connected'}
          />
          <p>{result.summary}</p>
          {result.detail && !result.ok && <p className={settings.note}>{result.detail}</p>}
        </div>
      )}
      {diagnosis && (
        <div role="status" data-diagnosis>
          <p className={styles.helperWho}>Likely cause</p>
          <p>{diagnosis.cause}</p>
          {diagnosis.steps.length > 0 && (
            <>
              <p className={styles.helperWho}>What to try</p>
              <ol className={styles.helperSteps}>
                {diagnosis.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          )}
          <p className={settings.note}>
            {diagnosis.bug
              ? `Saved as a bug in ticket ${diagnosis.bug.reference}${diagnosis.bug.created ? '' : ' (added to the open one for this address)'}.`
              : 'The bug could not be saved as a ticket. Please tell an administrator.'}
          </p>
        </div>
      )}
      {error && <p className={settings.error}>{error}</p>}
    </div>
  );
}
