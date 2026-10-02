import {
  AI_CHANNEL_MODES,
  AI_CHANNELS,
  type AiBehaviour,
  type AiChannel,
  type AiChannelMode,
  type SimulateAiResult,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader, Input, Select, Textarea } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import { DECISION_LABELS, percent, ruleLabels } from '../ai/logic';
import styles from './Settings.module.css';

const CHANNEL_LABELS: Record<AiChannel, string> = {
  webchat: 'Web chat',
  whatsapp: 'WhatsApp',
  voice: 'Voice',
  email: 'Email',
  web_form: 'Web form (replies by email)',
  api: 'Integrations (tickets raised through the API)',
};

const MODE_LABELS: Record<AiChannelMode, string> = {
  auto: 'Answers on its own when confident',
  draft: 'Drafts replies for a person to approve',
  off: 'Off: people answer',
};

/** Settings → AI behaviour: autonomy per channel, thresholds, and a dry run. */
export function AiPanel() {
  const current = useGet<AiBehaviour>('/settings/ai');
  const [form, setForm] = useState<AiBehaviour | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (current.data) setForm(current.data);
  }, [current.data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      setForm(await api<AiBehaviour>('PUT', '/settings/ai', form));
      setMessage('Saved. New turns use these settings.');
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pct = (key: 'sendAt' | 'handoverBelow') => (
    <Input
      id={`ai-${key}`}
      type="number"
      min={0}
      max={100}
      step={5}
      label={key === 'sendAt' ? 'Send on its own at (%)' : 'Hand over below (%)'}
      value={form ? Math.round(form[key] * 100) : ''}
      onChange={(e) => form && setForm({ ...form, [key]: Number(e.target.value) / 100 })}
      hint={
        key === 'sendAt'
          ? 'At or above this confidence, replies go out on channels that answer on their own.'
          : 'Below this, the AI passes the conversation to your team. In between, it drafts.'
      }
    />
  );

  return (
    <div className={styles.stack}>
      <Card padding="md">
        <CardHeader
          title="AI behaviour"
          subtitle="What the AI agent may do on each channel, and how sure it must be."
        />
        {current.error && <p className={styles.error}>{current.error}</p>}
        {form && (
          <form className={styles.form} onSubmit={save} aria-label="AI behaviour">
            <div className={styles.formRow}>
              {AI_CHANNELS.map((ch) => (
                <Select
                  key={ch}
                  id={`ai-mode-${ch}`}
                  label={CHANNEL_LABELS[ch]}
                  value={form.channels[ch]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      channels: { ...form.channels, [ch]: e.target.value as AiChannelMode },
                    })
                  }
                  options={AI_CHANNEL_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
                />
              ))}
            </div>
            <div className={styles.formRow}>
              {pct('sendAt')}
              {pct('handoverBelow')}
            </div>
            <div className={styles.formRow}>
              <Input
                id="ai-failed"
                type="number"
                min={1}
                max={20}
                label="Hand over after this many unsure replies"
                value={form.maxFailedTurns}
                onChange={(e) => setForm({ ...form, maxFailedTurns: Number(e.target.value) })}
              />
              <Select
                id="ai-classify"
                label="Classify new tickets"
                value={form.classifyTickets ? 'yes' : 'no'}
                onChange={(e) => setForm({ ...form, classifyTickets: e.target.value === 'yes' })}
                options={[
                  { value: 'yes', label: 'Yes: category, priority, language, sentiment' },
                  { value: 'no', label: 'No' },
                ]}
              />
            </div>
            <Select
              id="ai-await"
              label="After a confident answer"
              value={form.awaitCustomerWhenAnswered ? 'yes' : 'no'}
              onChange={(e) =>
                setForm({ ...form, awaitCustomerWhenAnswered: e.target.value === 'yes' })
              }
              options={[
                { value: 'yes', label: 'Mark the ticket as waiting on the customer' },
                { value: 'no', label: 'Leave the status as it is' },
              ]}
            />
            <h3 className={styles.sectionTitle}>Ending a conversation</h3>
            <p className={styles.note}>
              When an answer settles the request, the AI asks whether anything else is needed. A
              “no, thanks” resolves the ticket at once, without asking a model. Silence resolves it
              after the quiet time below.
            </p>
            <Select
              id="ai-ask-anything-else"
              label="Ask “is there anything else?” after an answer that settles the request"
              value={form.closing.askAnythingElse ? 'yes' : 'no'}
              onChange={(e) =>
                setForm({
                  ...form,
                  closing: { ...form.closing, askAnythingElse: e.target.value === 'yes' },
                })
              }
              options={[
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No' },
              ]}
            />
            <div className={styles.formRow}>
              {AI_CHANNELS.map((ch) => (
                <Input
                  key={ch}
                  id={`ai-quiet-${ch}`}
                  type="number"
                  min={0}
                  max={43200}
                  label={`Quiet time: ${CHANNEL_LABELS[ch]} (minutes)`}
                  placeholder={`${form.autoResolveHours * 60} (the general setting)`}
                  value={form.closing.quietMinutes[ch] ?? ''}
                  onChange={(e) => {
                    const quietMinutes = { ...form.closing.quietMinutes };
                    if (e.target.value === '') delete quietMinutes[ch];
                    else quietMinutes[ch] = Number(e.target.value);
                    setForm({ ...form, closing: { ...form.closing, quietMinutes } });
                  }}
                  hint="Empty: the general setting below. 0: never."
                />
              ))}
            </div>
            <div className={styles.formRow}>
              <Select
                id="ai-tell-closed"
                label="Tell the customer when a request is closed for silence"
                value={form.closing.tellCustomer ? 'yes' : 'no'}
                onChange={(e) =>
                  setForm({
                    ...form,
                    closing: { ...form.closing, tellCustomer: e.target.value === 'yes' },
                  })
                }
                options={[
                  { value: 'yes', label: 'Yes, in web chat and in-app requests' },
                  { value: 'no', label: 'No' },
                ]}
              />
              <Input
                id="ai-close-days"
                type="number"
                min={0}
                max={365}
                label="Close a resolved ticket for good after (days; 0 = never)"
                value={String(form.closing.closeResolvedAfterDays)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    closing: { ...form.closing, closeResolvedAfterDays: Number(e.target.value) },
                  })
                }
                hint="Until then a reply from the customer reopens it. After, a reply opens a new ticket."
              />
            </div>
            <Input
              id="ai-auto-resolve"
              label="General quiet time: resolve the ticket when the customer has not replied for (hours; 0 = never)"
              type="number"
              min={0}
              max={720}
              value={String(form.autoResolveHours)}
              onChange={(e) => setForm({ ...form, autoResolveHours: Number(e.target.value) })}
              required
            />
            <Select
              id="ai-learn"
              label="Learn from customer ratings"
              value={form.learnFromRatings ? 'yes' : 'no'}
              onChange={(e) => setForm({ ...form, learnFromRatings: e.target.value === 'yes' })}
              options={[
                {
                  value: 'yes',
                  label: 'Yes: follow lessons, and ask a person on badly rated topics',
                },
                { value: 'no', label: 'No' },
              ]}
            />
            <p className={styles.note}>
              Only tickets the AI answered and still owns. A later reply from the customer reopens
              the ticket. These count as “resolved by the AI alone” in Reports.
            </p>
            <div className={styles.formActions}>
              <Button type="submit" disabled={saving}>
                Save AI behaviour
              </Button>
            </div>
            {message && (
              <p className={styles.note} role="status">
                {message}
              </p>
            )}
          </form>
        )}
      </Card>
      <TryAgent />
    </div>
  );
}

/** A dry run: the agent answers a made-up message; nothing is stored or sent. */
function TryAgent() {
  const [channel, setChannel] = useState<AiChannel>('webchat');
  const [text, setText] = useState('When will my refund reach my card?');
  const [result, setResult] = useState<SimulateAiResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(
        await api<SimulateAiResult>('POST', '/ai/simulate', {
          channel,
          messages: [{ author: 'customer', body: text }],
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md">
      <CardHeader
        title="Try the agent"
        subtitle="A dry run with the current settings, models and knowledge base. Nothing is sent."
      />
      <form className={styles.form} onSubmit={run} aria-label="Try the agent">
        <div className={styles.formRow}>
          <Select
            id="try-channel"
            label="Channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as AiChannel)}
            options={AI_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] }))}
          />
        </div>
        <Textarea
          id="try-message"
          label="Customer message"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.formActions}>
          <Button type="submit" disabled={busy || !text.trim()}>
            Run
          </Button>
        </div>
      </form>
      {error && <p className={styles.error}>{error}</p>}
      {result && (
        <div className={styles.form} role="status" aria-label="Agent result">
          <p>
            <strong>{DECISION_LABELS[result.decision]}</strong>
            <span className={styles.muted}>
              {' '}
              · confidence {percent(result.confidence)} · {result.model ?? 'no model'} ·{' '}
              {result.latencyMs} ms
            </span>
          </p>
          {result.reply && <p className={styles.tryOut}>“{result.reply}”</p>}
          {ruleLabels(result.rules).length > 0 && (
            <p className={styles.note}>{ruleLabels(result.rules).join('; ')}</p>
          )}
          {result.sources.length > 0 && (
            <p className={styles.note}>Sources: {result.sources.map((s) => s.label).join(', ')}</p>
          )}
        </div>
      )}
    </Card>
  );
}
