import type { ChatIdentitySecret, IntegrationView, WidgetHost } from '@tms/shared';
import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, CardHeader } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import settings from '../settings/Settings.module.css';
import styles from './Integrations.module.css';
import { widgetSnippet } from './logic';
import { SecretOnce } from './SecretOnce';

/**
 * How an integration's site adds the chat: the snippet to paste, and the
 * secret its server signs identity tokens with for logged-in visitors.
 */
export function ChatWidget({
  integration,
  onChanged,
}: {
  integration: IntegrationView;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const host = useGet<WidgetHost>('/integrations/widget-host');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const snippet = host.data ? widgetSnippet(host.data.origin, integration.slug) : null;

  const copy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setNote('Snippet copied.');
    } catch {
      setNote('Select the snippet and copy it by hand.');
    }
  };

  const generate = async () => {
    if (
      integration.chatIdentityLast4 &&
      !window.confirm(
        'Replace the identity secret? Tokens signed with the old one stop being accepted at once.',
      )
    ) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const made = await api<ChatIdentitySecret>(
        'POST',
        `/integrations/${integration.id}/chat-identity-secret`,
      );
      setSecret(made.secret);
      onChanged();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" aria-label={`Chat widget of ${integration.name}`}>
      <CardHeader
        title={`Chat widget · ${integration.name}`}
        subtitle="Paste this before </body> on the site. Chats started there are this integration’s tickets."
        actions={
          <Button variant="secondary" onClick={() => void copy()} disabled={!snippet}>
            Copy snippet
          </Button>
        }
      />
      {host.error && <p className={settings.error}>{host.error}</p>}
      {snippet && (
        <pre className={styles.snippet} data-testid="widget-snippet">
          <code>{snippet}</code>
        </pre>
      )}
      {note && (
        <p className={settings.note} role="status">
          {note}
        </p>
      )}
      {secret && (
        <SecretOnce
          title="Chat identity secret"
          label="New chat identity secret"
          value={secret}
          testId="new-chat-identity-secret"
          onDone={() => setSecret(null)}
        />
      )}
      <div className={styles.hookHead}>
        <div>
          <div>Logged-in visitors</div>
          <div className={settings.keyState}>
            The site’s server signs a short token (HS256: <code>sub</code>, <code>name</code>,{' '}
            <code>email</code>) with this secret and passes it as <code>identityToken</code>, so a
            visitor’s chat joins their other tickets.{' '}
            {integration.chatIdentityLast4
              ? `Secret set · ••••${integration.chatIdentityLast4}`
              : 'No secret yet: every visitor is anonymous.'}
          </div>
        </div>
        {can('settings:secrets') && (
          <div className={settings.actions}>
            <Button size="sm" disabled={busy} onClick={() => void generate()}>
              {integration.chatIdentityLast4 ? 'Replace secret' : 'Generate secret'}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
