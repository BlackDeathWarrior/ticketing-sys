import {
  KB_CONNECTOR_LABELS,
  KB_CONNECTOR_SECRETS,
  KB_CONNECTOR_TYPES,
  KB_VISIBILITIES,
  type HealthState,
  type KbConnectorType,
  type KbConnectorView,
  type KbVisibility,
} from '@tms/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAgentEvents } from '../../api/realtime';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  Input,
  Select,
  StatusLight,
  Textarea,
} from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { relativeFromIso } from '../settings/logic';
import styles from './Kb.module.css';

interface Field {
  key: string;
  label: string;
  hint?: string;
  kind?: 'number' | 'textarea';
  optional?: boolean;
  placeholder?: string;
}

/** What each kind of source asks for (the server checks it again: `kbConnectorConfigSchemas`). */
const CONFIG_FIELDS: Record<KbConnectorType, Field[]> = {
  website: [
    {
      key: 'url',
      label: 'Start page or sitemap address',
      placeholder: 'https://example.com/help/ or https://example.com/sitemap.xml',
    },
    {
      key: 'pathPrefix',
      label: 'Only pages under this path',
      optional: true,
      placeholder: '/help/',
    },
    { key: 'maxPages', label: 'At most this many pages (1–300)', kind: 'number' },
  ],
  github: [
    { key: 'repo', label: 'Repository (owner/name)', placeholder: 'acme/handbook' },
    { key: 'branch', label: 'Branch' },
    { key: 'path', label: 'Only files in this folder', optional: true, placeholder: 'docs' },
  ],
  notion: [
    {
      key: 'query',
      label: 'Only pages whose title contains',
      optional: true,
      hint: 'Empty: every page shared with the integration.',
    },
  ],
  google_drive: [
    {
      key: 'folderId',
      label: 'Folder id',
      hint: 'The last part of the folder’s address. Share the folder with the service account.',
    },
  ],
  s3: [
    { key: 'bucket', label: 'Bucket' },
    { key: 'region', label: 'Region' },
    {
      key: 'endpoint',
      label: 'Endpoint (only for S3-compatible services)',
      optional: true,
      placeholder: 'http://objectstore:8333',
    },
    { key: 'prefix', label: 'Only keys starting with', optional: true, placeholder: 'policies/' },
  ],
  folder: [
    {
      key: 'path',
      label: 'Folder',
      hint: 'A path the worker can read, inside one of the folders allowed by KB_CONNECTOR_PATHS (where a NAS share is mounted).',
    },
  ],
  postgres: [
    {
      key: 'query',
      label: 'Query (one SELECT)',
      kind: 'textarea',
      hint: 'It runs read-only, with a time limit and at most 500 rows.',
      placeholder: 'SELECT id, question, answer FROM faqs WHERE published',
    },
    { key: 'idColumn', label: 'Column with a unique id' },
    { key: 'titleColumn', label: 'Column with the title' },
    { key: 'bodyColumn', label: 'Column with the text' },
  ],
};

const DEFAULTS: Record<KbConnectorType, Record<string, string>> = {
  website: { maxPages: '50' },
  github: { branch: 'main' },
  notion: {},
  google_drive: {},
  s3: { region: 'us-east-1' },
  folder: {},
  postgres: {},
};

const SCHEDULES = [
  { value: '0', label: 'Only when someone asks' },
  { value: '60', label: 'Every hour' },
  { value: '360', label: 'Every 6 hours' },
  { value: '1440', label: 'Every day' },
  { value: '10080', label: 'Every week' },
];

const scheduleLabel = (m: number) =>
  SCHEDULES.find((s) => Number(s.value) === m)?.label ?? `Every ${m} minutes`;

function light(c: KbConnectorView): { state: HealthState; label: string } {
  if (!c.enabled) return { state: 'off', label: 'Paused' };
  if (c.status === 'syncing') return { state: 'ok', label: 'Syncing…' };
  if (c.status === 'failed') return { state: 'down', label: 'Last sync failed' };
  if (c.status === 'ok' && c.lastError) return { state: 'warning', label: 'Synced, with problems' };
  if (c.status === 'ok') return { state: 'ok', label: 'Synced' };
  return { state: 'off', label: 'Not synced yet' };
}

function describe(c: KbConnectorView): string {
  const cfg = c.config as Record<string, string | undefined>;
  switch (c.type) {
    case 'website':
      return cfg.url ?? '';
    case 'github':
      return `${cfg.repo}${cfg.path ? `/${cfg.path}` : ''} (${cfg.branch})`;
    case 'notion':
      return cfg.query ? `Pages matching “${cfg.query}”` : 'Every shared page';
    case 'google_drive':
      return `Folder ${cfg.folderId}`;
    case 's3':
      return `${cfg.bucket}${cfg.prefix ? `/${cfg.prefix}` : ''}`;
    case 'folder':
      return cfg.path ?? '';
    case 'postgres':
      return `${cfg.titleColumn} / ${cfg.bodyColumn}`;
  }
}

/** Knowledge base → Sources (ADR 0033): outside sources kept in sync, for kb:manage. */
export function KbSources() {
  const connectors = useGet<KbConnectorView[]>('/kb/connectors');
  const [editing, setEditing] = useState<KbConnectorView | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const list = connectors.data ?? [];
  const syncing = list.some((c) => c.status === 'syncing');
  const { reload } = connectors;

  useAgentEvents((events) => {
    if (events.some((e) => e.type.startsWith('kb.connector') || e.type === 'live.resumed'))
      void connectors.reload();
  });

  // A sync's progress is not an event; look again while one runs.
  useEffect(() => {
    if (!syncing) return;
    const t = window.setInterval(() => void reload(), 4000);
    return () => window.clearInterval(t);
  }, [syncing, reload]);

  const act = async (c: KbConnectorView, fn: () => Promise<string | null>) => {
    setBusy(c.id);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
      void connectors.reload();
    }
  };

  const test = (c: KbConnectorView) =>
    act(c, async () => {
      const r = await api<{ ok: boolean; found: number; sample: string[]; error: string | null }>(
        'POST',
        `/kb/connectors/${c.id}/test`,
      );
      if (!r.ok) return `${c.name}: ${r.error}`;
      if (!r.found) return `${c.name}: connected, but nothing was found to bring in.`;
      return `${c.name}: connected, ${r.found} item${r.found === 1 ? '' : 's'} found (${r.sample.join(', ')}${r.found > r.sample.length ? ', …' : ''}).`;
    });
  const sync = (c: KbConnectorView) =>
    act(c, async () => {
      await api('POST', `/kb/connectors/${c.id}/sync`);
      return `${c.name}: sync started.`;
    });
  const toggle = (c: KbConnectorView) =>
    act(c, async () => {
      await api('PATCH', `/kb/connectors/${c.id}`, { enabled: !c.enabled });
      return `${c.name} ${c.enabled ? 'paused' : 'resumed'}.`;
    });
  const remove = (c: KbConnectorView) => {
    if (
      !window.confirm(
        `Remove “${c.name}”? What it brought in stays in the knowledge base as ordinary documents.`,
      )
    )
      return;
    void act(c, async () => {
      await api('DELETE', `/kb/connectors/${c.id}`);
      return `${c.name} removed.`;
    });
  };

  return (
    <Card padding="md">
      <CardHeader
        title="Sources"
        subtitle="Websites, repositories, drives, buckets, folders and databases kept in sync. What they bring in starts as drafts unless you let a source approve its own."
        actions={
          <Button icon="plus" variant="secondary" onClick={() => setEditing('new')}>
            Add source
          </Button>
        }
      />
      {message && (
        <p className={styles.note} role="status">
          {message}
        </p>
      )}
      {connectors.error && <p className={styles.error}>{connectors.error}</p>}
      {!connectors.loading && !list.length && (
        <p className={styles.note}>No sources yet. Documents are added by hand below.</p>
      )}
      {list.length > 0 && (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">State</th>
                <th scope="col">Last sync</th>
                <th scope="col">Documents</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const l = light(c);
                return (
                  <tr key={c.id} className={c.enabled ? undefined : styles.dim}>
                    <td>
                      <div className={styles.docTitle}>{c.name}</div>
                      <div className={styles.muted}>
                        {KB_CONNECTOR_LABELS[c.type]} · {describe(c)}
                      </div>
                      <div className={styles.muted}>
                        {scheduleLabel(c.scheduleMinutes)}
                        {c.autoApprove ? ' · approves its own' : ' · drafts for review'}
                        {KB_CONNECTOR_SECRETS[c.type].some(
                          (f) => !f.optional && !c.secrets.find((s) => s.field === f.field)?.set,
                        ) && ' · credentials missing'}
                      </div>
                    </td>
                    <td title={c.lastError ?? undefined}>
                      <StatusLight state={l.state} label={l.label} />
                      {c.lastError && <div className={styles.muted}>{c.lastError}</div>}
                    </td>
                    <td className={styles.muted}>
                      {c.lastSyncAt ? relativeFromIso(c.lastSyncAt) : 'Never'}
                      {c.stats && (
                        <div>
                          {c.stats.added} new, {c.stats.updated} changed, {c.stats.archived}{' '}
                          archived
                        </div>
                      )}
                    </td>
                    <td className={styles.nowrap}>{c.documents}</td>
                    <td>
                      <div className={styles.actions}>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === c.id || c.status === 'syncing' || !c.enabled}
                          onClick={() => void sync(c)}
                        >
                          Sync now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === c.id}
                          onClick={() => void test(c)}
                        >
                          Test
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === c.id}
                          onClick={() => setEditing(c)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === c.id}
                          onClick={() => void toggle(c)}
                        >
                          {c.enabled ? 'Pause' : 'Resume'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === c.id}
                          onClick={() => remove(c)}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} labelledBy="kb-source-title">
        {editing && (
          <SourceForm
            current={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(c, created) => {
              setEditing(null);
              setMessage(
                created
                  ? `${c.name} added. Press Test to check it, then Sync now.`
                  : `${c.name} saved.`,
              );
              void connectors.reload();
            }}
          />
        )}
      </Dialog>
    </Card>
  );
}

function SourceForm({
  current,
  onCancel,
  onSaved,
}: {
  current: KbConnectorView | null;
  onCancel: () => void;
  onSaved: (c: KbConnectorView, created: boolean) => void;
}) {
  const { can } = useSession();
  const mayKeys = can('settings:secrets');
  const teams = useGet<Array<{ id: string; name: string }>>('/teams');
  const [type, setType] = useState<KbConnectorType>(current?.type ?? 'website');
  const [name, setName] = useState(current?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(() =>
    current
      ? Object.fromEntries(
          Object.entries(current.config).map(([k, v]) => [k, v == null ? '' : String(v)]),
        )
      : DEFAULTS.website,
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<KbVisibility>(current?.visibility ?? 'internal');
  const [teamId, setTeamId] = useState(current?.teamId ?? '');
  const [autoApprove, setAutoApprove] = useState(current?.autoApprove ?? false);
  const [schedule, setSchedule] = useState(String(current?.scheduleMinutes ?? 1440));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const pickType = (t: KbConnectorType) => {
    setType(t);
    setConfig(DEFAULTS[t]);
    setSecrets({});
  };

  const configBody = () => {
    const out: Record<string, string | number> = {};
    for (const f of CONFIG_FIELDS[type]) {
      const v = (config[f.key] ?? '').trim();
      if (!v) continue;
      out[f.key] = f.kind === 'number' ? Number(v) : v;
    }
    return out;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
      const body = {
        name: name.trim(),
        visibility,
        teamId: visibility === 'team' ? teamId || null : null,
        autoApprove,
        scheduleMinutes: Number(schedule),
        config: configBody(),
        ...(Object.keys(filled).length ? { secrets: filled } : {}),
      };
      const saved = current
        ? await api<KbConnectorView>('PATCH', `/kb/connectors/${current.id}`, body)
        : await api<KbConnectorView>('POST', '/kb/connectors', { type, ...body });
      onSaved(saved, !current);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const secretFields = KB_CONNECTOR_SECRETS[type];
  return (
    <form className={styles.form} onSubmit={submit}>
      <div>
        <h2 id="kb-source-title" className={styles.dialogTitle}>
          {current ? `Edit ${current.name}` : 'Add a source'}
        </h2>
        <p className={styles.dialogLede}>
          Each sync brings in what is new, a new version of what changed, and archives what
          disappeared from the source.
        </p>
      </div>
      <div className={styles.formRow}>
        <Select
          id="kb-source-type"
          label="Kind"
          value={type}
          disabled={!!current}
          onChange={(e) => pickType(e.target.value as KbConnectorType)}
          options={KB_CONNECTOR_TYPES.map((t) => ({ value: t, label: KB_CONNECTOR_LABELS[t] }))}
        />
        <Input
          id="kb-source-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
      </div>
      {CONFIG_FIELDS[type].map((f) =>
        f.kind === 'textarea' ? (
          <Textarea
            key={f.key}
            id={`kb-source-${f.key}`}
            label={f.hint ? `${f.label}. ${f.hint}` : f.label}
            rows={4}
            value={config[f.key] ?? ''}
            placeholder={f.placeholder}
            required={!f.optional}
            onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
          />
        ) : (
          <Input
            key={f.key}
            id={`kb-source-${f.key}`}
            label={f.label}
            hint={f.hint}
            type={f.kind === 'number' ? 'number' : 'text'}
            value={config[f.key] ?? ''}
            placeholder={f.placeholder}
            required={!f.optional}
            onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
          />
        ),
      )}
      {secretFields.length > 0 &&
        (mayKeys ? (
          secretFields.map((f) => {
            const set = current?.secrets.find((s) => s.field === f.field)?.set;
            return f.field === 'service_account' ? (
              <Textarea
                key={f.field}
                id={`kb-source-secret-${f.field}`}
                label={set ? `${f.label}: saved; paste a new one to replace it` : f.label}
                rows={4}
                value={secrets[f.field] ?? ''}
                required={!current && !f.optional}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSecrets({ ...secrets, [f.field]: e.target.value })}
              />
            ) : (
              <Input
                key={f.field}
                id={`kb-source-secret-${f.field}`}
                label={f.label}
                hint={set ? 'Saved. Leave empty to keep it.' : undefined}
                type="password"
                autoComplete="new-password"
                value={secrets[f.field] ?? ''}
                required={!current && !f.optional}
                onChange={(e) => setSecrets({ ...secrets, [f.field]: e.target.value })}
              />
            );
          })
        ) : (
          <p className={styles.note}>
            This source needs credentials. Someone who may manage keys has to enter them.
          </p>
        ))}
      <div className={styles.formRow}>
        <Select
          id="kb-source-visibility"
          label="What it brings in is visible to"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as KbVisibility)}
          options={KB_VISIBILITIES.map((v) => ({
            value: v,
            label:
              v === 'public'
                ? 'Public: the AI may quote it to customers'
                : v === 'internal'
                  ? 'Internal: agents only'
                  : 'One team',
          }))}
        />
        {visibility === 'team' ? (
          <Select
            id="kb-source-team"
            label="Team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            options={[
              { value: '', label: 'Choose a team' },
              ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        ) : (
          <Select
            id="kb-source-schedule"
            label="Sync"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            options={SCHEDULES}
          />
        )}
      </div>
      {visibility === 'team' && (
        <Select
          id="kb-source-schedule"
          label="Sync"
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          options={SCHEDULES}
        />
      )}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={(e) => setAutoApprove(e.target.checked)}
        />
        Approve what it brings in without a review (only for a source you trust)
      </label>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.formActions}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {current ? 'Save' : 'Add source'}
        </Button>
      </div>
    </form>
  );
}
