import { type McpServerView, TOOL_TIERS, type ToolTier, type ToolView } from '@tms/shared';
import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  Icon,
  Input,
  Select,
  Textarea,
} from '../../components/ui';
import { cx, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { minutesSince } from '../../data/adapters';
import { SecretField } from '../settings/ChannelsPanel';
import settings from '../settings/Settings.module.css';
import { CustomTools } from './CustomTools';
import { parseArgs, resultPreview, schemaArgs, tierLabel } from './logic';
import styles from './Tools.module.css';

/**
 * Settings → Tools & MCP: MCP servers that expose company systems, their
 * tools, and what the AI may do with each (ADR 0013).
 */
export function ToolsPanel() {
  const { can } = useSession();
  // Someone allowed to create custom tools, but not to manage servers, sees only those.
  const manage = can('tool:manage');
  return (
    <div className={settings.stack}>
      {manage && <McpServers />}
      {can('tool:create') && <CustomTools />}
    </div>
  );
}

function McpServers() {
  const servers = useGet<McpServerView[]>('/tools/servers');
  const tools = useGet<ToolView[]>('/tools');
  const reload = () => {
    void servers.reload();
    void tools.reload();
  };

  return (
    <>
      <p className={settings.note}>
        The AI can use tools from these servers to look up and act on a customer’s orders, payments
        and account. New tools start switched off. “Needs approval” tools only submit a request: a
        supervisor approves it in Approvals before anything happens.
      </p>
      {servers.error && <p className={settings.error}>{servers.error}</p>}
      {servers.data?.map((s) => (
        <ServerCard
          key={s.id}
          server={s}
          tools={(tools.data ?? []).filter((t) => t.serverId === s.id && !t.missing)}
          onChanged={reload}
        />
      ))}
      {servers.data && servers.data.length === 0 && (
        <p className={settings.note}>No MCP servers yet.</p>
      )}
      <AddServer onAdded={reload} />
    </>
  );
}

function ServerCard({
  server,
  tools,
  onChanged,
}: {
  server: McpServerView;
  tools: ToolView[];
  onChanged: () => void;
}) {
  const { can } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (done) setMessage(done);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const synced = server.lastSyncedAt
    ? `Synced ${relativeTime(minutesSince(new Date(server.lastSyncedAt)))}`
    : 'Never synced';

  return (
    <Card padding="md" aria-labelledby={`server-${server.id}`}>
      <CardHeader
        id={`server-${server.id}`}
        title={server.name}
        subtitle={<span className={settings.mono}>{server.url}</span>}
        actions={
          <>
            <Button
              size="sm"
              onClick={() =>
                run(
                  () => api<ToolView[]>('POST', `/tools/servers/${server.id}/sync`),
                  'Tools refreshed.',
                )
              }
              disabled={busy}
            >
              Sync tools
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                run(() => api('PATCH', `/tools/servers/${server.id}`, { enabled: !server.enabled }))
              }
              disabled={busy}
            >
              {server.enabled ? 'Disable' : 'Enable'}
            </Button>
          </>
        }
      />
      <div className={settings.stack}>
        <p className={styles.meta}>
          <span className={cx(styles.status, !server.enabled && styles.quiet)}>
            <Icon name={server.enabled ? 'check' : 'x'} size={14} />
            {server.enabled ? 'On' : 'Off'}
          </span>
          <span>{synced}</span>
          <span>
            {server.toolCount} tool{server.toolCount === 1 ? '' : 's'}
          </span>
          {server.lastError && (
            <span className={cx(styles.status, styles.attention)}>
              <Icon name="alert" size={14} />
              Last sync failed: {server.lastError}
            </span>
          )}
        </p>
        {server.authHeader && (
          <SecretField
            secret={{
              key: server.token.key,
              label: `Token (sent as ${server.authHeader})`,
              set: server.token.set,
              last4: server.token.last4,
            }}
            canEdit={can('settings:secrets')}
            onChanged={onChanged}
          />
        )}
        {message && (
          <p className={settings.note} role="status">
            {message}
          </p>
        )}
        {tools.length > 0 && (
          <ul className={styles.list} aria-label={`${server.name} tools`}>
            {tools.map((t) => (
              <ToolRow key={t.id} tool={t} onChanged={onChanged} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function ToolRow({ tool, onChanged }: { tool: ToolView; onChanged: () => void }) {
  const teams = useGet<Array<{ id: string; name: string }>>('/teams');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const args = schemaArgs(tool.inputSchema);

  const update = async (patch: Partial<ToolView>) => {
    setError(null);
    try {
      await api('PATCH', `/tools/${tool.id}`, patch);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      onChanged();
    }
  };

  const id = `tool-${tool.id}`;
  return (
    <li className={cx(styles.tool, !tool.enabled && styles.off)} data-tool={tool.name}>
      <div>
        <p className={styles.toolName}>
          {tool.title ?? tool.name}
          <span className={styles.toolKey}>{tool.name}</span>
        </p>
        <p className={styles.toolDesc}>{tool.description}</p>
        {error && <p className={settings.error}>{error}</p>}
      </div>
      <div className={styles.controls}>
        <Select
          id={`${id}-enabled`}
          label="AI may use it"
          value={tool.enabled ? 'yes' : 'no'}
          onChange={(e) => void update({ enabled: e.target.value === 'yes' })}
          options={[
            { value: 'no', label: 'No' },
            { value: 'yes', label: 'Yes' },
          ]}
        />
        <Select
          id={`${id}-tier`}
          label="Risk"
          value={tool.tier}
          onChange={(e) => void update({ tier: e.target.value as ToolTier })}
          options={TOOL_TIERS.map((t) => ({ value: t, label: tierLabel(t) }))}
        />
        {tool.tier === 'transactional' && (
          <Select
            id={`${id}-approver`}
            label="Approved by"
            value={tool.approverTeamId ?? ''}
            onChange={(e) => void update({ approverTeamId: e.target.value || null })}
            options={[
              { value: '', label: 'The ticket’s own team' },
              ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        )}
        <Select
          id={`${id}-customer`}
          label="Customer email goes in"
          value={tool.customerArg ?? ''}
          onChange={(e) => void update({ customerArg: e.target.value || null })}
          options={[{ value: '', label: 'Nothing' }, ...args.map((a) => ({ value: a, label: a }))]}
        />
        <Button
          size="sm"
          onClick={() => setTesting(true)}
          disabled={tool.tier === 'transactional'}
          title={
            tool.tier === 'transactional'
              ? 'Needs-approval tools only run after an approval on a ticket'
              : undefined
          }
        >
          Test
        </Button>
      </div>
      <TestDialog tool={tool} open={testing} onClose={() => setTesting(false)} />
    </li>
  );
}

export function TestDialog({
  tool,
  path,
  open,
  onClose,
}: {
  tool: ToolView;
  /** Where to post the test; custom tools have their own route. */
  path?: string;
  open: boolean;
  onClose: () => void;
}) {
  const hidden = tool.customerArg ? [tool.customerArg] : [];
  const example = Object.fromEntries(
    schemaArgs(tool.inputSchema)
      .filter((a) => !hidden.includes(a))
      .map((a) => [a, '']),
  );
  const [args, setArgs] = useState(JSON.stringify(example, null, 2));
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseArgs(args);
    if (!parsed.ok) return setResult(parsed.error);
    setBusy(true);
    try {
      const r = await api<Record<string, unknown>>('POST', path ?? `/tools/${tool.id}/test`, {
        args: parsed.value,
        ...(email.trim() ? { customerEmail: email.trim() } : {}),
      });
      setResult(JSON.stringify(r, null, 2));
    } catch (err) {
      setResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const titleId = `test-${tool.id}`;
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId}>
      <form onSubmit={run} className={settings.form} aria-label={`Test ${tool.name}`}>
        <h2 id={titleId} className={settings.dialogTitle}>
          Test {tool.title ?? tool.name}
        </h2>
        <p className={settings.dialogLede}>
          Runs the tool once and records the call. Use a fictional customer.
        </p>
        {tool.customerArg && (
          <Input
            id={`${titleId}-email`}
            label={`Customer email (fills ${tool.customerArg})`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        <Textarea
          id={`${titleId}-args`}
          label="Arguments (JSON)"
          rows={5}
          spellCheck={false}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <div className={settings.formActions}>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Run test
          </Button>
        </div>
        {result && (
          <pre className={styles.pre} role="status" aria-label="Test result">
            {resultPreview(result, 4000)}
          </pre>
        )}
      </form>
    </Dialog>
  );
}

function AddServer({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authHeader, setAuthHeader] = useState('Authorization');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/tools/servers', {
        name: name.trim(),
        url: url.trim(),
        authHeader: authHeader || null,
      });
      setName('');
      setUrl('');
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" aria-labelledby="add-server">
      <CardHeader
        id="add-server"
        title="Add an MCP server"
        subtitle="Streamable HTTP. Internal addresses are refused unless an operator allowed the host."
      />
      <form className={settings.form} onSubmit={add} aria-label="Add an MCP server">
        <div className={settings.formRow}>
          <Input
            id="server-name"
            label="Name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Order system"
          />
          <Input
            id="server-url"
            label="URL"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://mcp.example.com/mcp"
          />
          <Select
            id="server-auth"
            label="Token header"
            value={authHeader}
            onChange={(e) => setAuthHeader(e.target.value)}
            options={[
              { value: 'Authorization', label: 'Authorization: Bearer' },
              { value: 'X-Api-Key', label: 'X-Api-Key' },
              { value: '', label: 'No token' },
            ]}
          />
        </div>
        <div className={settings.formActions}>
          <Button type="submit" disabled={busy || !name.trim() || !url.trim()}>
            Add server
          </Button>
        </div>
        {error && <p className={settings.error}>{error}</p>}
      </form>
    </Card>
  );
}
