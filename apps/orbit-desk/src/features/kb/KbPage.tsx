import {
  KB_VISIBILITIES,
  type KbDocumentView,
  type KbStatus,
  type KbVisibility,
} from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api, apiForm, openFile } from '../../api/client';
import { useAgentEvents } from '../../api/realtime';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  Input,
  Select,
  Tabs,
  Textarea,
} from '../../components/ui';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { relativeFromIso } from '../settings/logic';
import styles from './Kb.module.css';
import { KbSearch } from './KbSearch';
import {
  formatBytes,
  indexLabel,
  SOURCE_LABELS,
  STATUS_LABELS,
  statusActions,
  VISIBILITY_LABELS,
} from './logic';

/** Knowledge base (#/kb): search for everyone with kb:read; documents and review for kb:manage. */
export function KbPage() {
  const { can } = useSession();
  const manager = can('kb:manage');
  const docs = useGet<KbDocumentView[]>('/kb/documents');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useAgentEvents((e) => {
    if (e.type.startsWith('kb.')) void docs.reload();
  });

  const act = async (d: KbDocumentView, fn: () => Promise<unknown>, done?: string) => {
    setBusy(d.id);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(null);
      void docs.reload();
    }
  };

  const setStatus = (d: KbDocumentView, status: KbStatus) =>
    act(
      d,
      () => api('POST', `/kb/documents/${d.id}/status`, { status }),
      `${d.title}: ${STATUS_LABELS[status].toLowerCase()}.`,
    );
  const reindex = (d: KbDocumentView) =>
    act(d, () => api('POST', `/kb/documents/${d.id}/reindex`), `${d.title}: queued for indexing.`);
  const remove = (d: KbDocumentView) => {
    if (!window.confirm(`Delete “${d.title}”? It will no longer be used for answers.`)) return;
    void act(d, () => api('DELETE', `/kb/documents/${d.id}`), `${d.title} deleted.`);
  };

  const list = docs.data ?? [];
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Knowledge base</p>
        <h1 className={styles.heading}>Answers, with sources</h1>
        <p className={styles.lede}>
          Policies, FAQs and help pages the AI agent and your team answer from. Only approved
          documents are searched, and customers only ever get answers from public ones.
        </p>
      </header>

      <Card padding="md">
        <CardHeader
          title="Search"
          subtitle="The same hybrid search the AI agent uses, with citations."
        />
        <KbSearch id="kb-page-search" limit={8} />
      </Card>

      <Card padding="md">
        <CardHeader
          title="Documents"
          subtitle={
            manager
              ? 'New and edited documents start as drafts until someone approves them.'
              : 'Approved documents you can read.'
          }
          actions={
            manager && (
              <Button icon="plus" onClick={() => setAdding(true)}>
                Add document
              </Button>
            )
          }
        />
        {message && (
          <p className={styles.note} role="status">
            {message}
          </p>
        )}
        {docs.error && <p className={styles.error}>{docs.error}</p>}
        {!docs.loading && !list.length && <p className={styles.note}>No documents yet.</p>}
        {list.length > 0 && (
          <div className={styles.scroller}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Visible to</th>
                  <th scope="col">Review</th>
                  <th scope="col">Search index</th>
                  <th scope="col">Updated</th>
                  {manager && (
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} className={d.status === 'archived' ? styles.dim : undefined}>
                    <td>
                      <div className={styles.docTitle}>{d.title}</div>
                      <div className={styles.muted}>
                        {SOURCE_LABELS[d.source]}
                        {d.filename && ` · ${d.filename} ${formatBytes(d.sizeBytes)}`}
                        {d.url && ` · ${new URL(d.url).hostname}`}
                        {d.version > 1 && ` · v${d.version}`}
                        {d.source === 'file' && (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className={styles.link}
                              onClick={() => void openFile(`/kb/documents/${d.id}/file`)}
                            >
                              Open
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    <td className={styles.nowrap}>
                      {d.visibility === 'team'
                        ? (d.team?.name ?? 'Team')
                        : VISIBILITY_LABELS[d.visibility]}
                    </td>
                    <td>
                      <span className={styles.status}>
                        <span
                          className={cx(styles.glyph, styles[`glyph-${d.status}`])}
                          aria-hidden="true"
                        />
                        {STATUS_LABELS[d.status]}
                      </span>
                    </td>
                    <td
                      title={d.indexError ?? undefined}
                      className={d.indexState === 'failed' ? styles.docTitle : undefined}
                    >
                      {indexLabel(d)}
                    </td>
                    <td className={cx(styles.nowrap, styles.muted)}>
                      {relativeFromIso(d.updatedAt)}
                    </td>
                    {manager && (
                      <td>
                        <div className={styles.actions}>
                          {statusActions(d.status).map((a) => (
                            <Button
                              key={a.to}
                              size="sm"
                              variant={a.to === 'approved' ? 'secondary' : 'ghost'}
                              disabled={busy === d.id}
                              onClick={() => void setStatus(d, a.to)}
                            >
                              {a.label}
                            </Button>
                          ))}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === d.id}
                            onClick={() => void reindex(d)}
                          >
                            Reindex
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === d.id}
                            onClick={() => remove(d)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} labelledBy="kb-add-title">
        {adding && (
          <AddDocument
            onCancel={() => setAdding(false)}
            onSaved={(title) => {
              setAdding(false);
              setMessage(`${title} added as a draft; it is being indexed.`);
              void docs.reload();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

type Kind = 'file' | 'faq' | 'text' | 'url';

function AddDocument({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (title: string) => void;
}) {
  const teams = useGet<Array<{ id: string; name: string }>>('/teams');
  const [kind, setKind] = useState<Kind>('file');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<KbVisibility>('internal');
  const [teamId, setTeamId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const team = visibility === 'team' ? teamId || null : null;
      if (kind === 'file') {
        if (!file) throw new Error('Choose a file');
        const form = new FormData();
        if (title.trim()) form.append('title', title.trim());
        form.append('visibility', visibility);
        if (team) form.append('teamId', team);
        form.append('file', file);
        const doc = await apiForm<KbDocumentView>('/kb/documents/upload', form);
        onSaved(doc.title);
        return;
      }
      const doc = await api<KbDocumentView>('POST', '/kb/documents', {
        source: kind,
        title: title.trim(),
        visibility,
        teamId: team,
        ...(kind === 'url' ? { url: url.trim() } : { content }),
      });
      onSaved(doc.title);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <div>
        <h2 id="kb-add-title" className={styles.dialogTitle}>
          Add a document
        </h2>
        <p className={styles.dialogLede}>
          PDF, Word (.docx), Markdown, HTML or text files; a web page; or a single question and
          answer.
        </p>
      </div>
      <Tabs
        label="Document type"
        value={kind}
        onChange={setKind}
        items={[
          { value: 'file', label: 'Upload a file' },
          { value: 'faq', label: 'FAQ entry' },
          { value: 'text', label: 'Text' },
          { value: 'url', label: 'Web page' },
        ]}
      />
      {kind === 'file' && (
        <label className={styles.file}>
          <span className="visually-hidden">File</span>
          <input
            type="file"
            aria-label="File"
            accept=".pdf,.docx,.md,.markdown,.html,.htm,.txt"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
      <Input
        id="kb-title"
        label={
          kind === 'faq'
            ? 'Question'
            : kind === 'file'
              ? 'Title (optional: taken from the document)'
              : 'Title'
        }
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required={kind !== 'file'}
      />
      {kind === 'url' && (
        <Input
          id="kb-url"
          label="Page address"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      )}
      {(kind === 'faq' || kind === 'text') && (
        <Textarea
          id="kb-content"
          label={
            kind === 'faq' ? 'Answer' : 'Text (Markdown headings like “## Refunds” become sections)'
          }
          rows={kind === 'faq' ? 5 : 10}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          required
        />
      )}
      <div className={styles.formRow}>
        <Select
          id="kb-visibility"
          label="Visible to"
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
        {visibility === 'team' && (
          <Select
            id="kb-team"
            label="Team"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            options={[
              { value: '', label: 'Choose a team' },
              ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        )}
      </div>
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
          Add as draft
        </Button>
      </div>
    </form>
  );
}
