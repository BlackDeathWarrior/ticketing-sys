import {
  type CsatView,
  PORTAL_LINK_MINUTES,
  PORTAL_STATUS_LABELS,
  type PortalSession,
  type PortalTicketDetail,
  type PortalTicketSummary,
} from '@tms/shared';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, formatBytes } from './logic';
import {
  authorLabel,
  CHANNEL_LABELS,
  dateTime,
  hrefFor,
  readSession,
  type Route,
  saveSession,
} from './portal-logic';
import { RatingForm } from './RatingForm';

const API = '/api/v1';

class SignedOut extends Error {}

/** Calls the portal API as the signed-in customer. A refused session signs the page out. */
async function portalApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new SignedOut();
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorMessage(data, res.status));
  return data as T;
}

type PortalRoute = Extract<Route, { page: 'portal' | 'verify' | 'ticket' }>;

/** "My requests": sign in with an emailed link, then see, answer and rate your own requests. */
export function Portal({ route }: { route: PortalRoute }) {
  const [session, setSession] = useState(() => readSession(sessionStorage));
  const [notice, setNotice] = useState<string | null>(null);

  const signOut = useCallback((message: string | null = null) => {
    saveSession(sessionStorage, null);
    setSession(null);
    setNotice(message);
  }, []);
  const expired = useCallback(
    () => signOut('You have been signed out. Ask for a new link to continue.'),
    [signOut],
  );

  if (route.page === 'verify') {
    return (
      <Verify
        token={route.token}
        onSignedIn={(s) => {
          saveSession(sessionStorage, s);
          setSession(readSession(sessionStorage));
          setNotice(null);
          window.location.replace(hrefFor({ page: 'portal' }));
        }}
      />
    );
  }
  if (!session) return <SignIn notice={notice} />;

  return (
    <>
      <p className="signed-in">
        Signed in as <strong>{session.email}</strong>
        <button type="button" className="link-button" onClick={() => signOut()}>
          Sign out
        </button>
      </p>
      {route.page === 'ticket' ? (
        <TicketDetail token={session.token} reference={route.reference} onExpired={expired} />
      ) : (
        <TicketList token={session.token} name={session.name} onExpired={expired} />
      )}
    </>
  );
}

function SignIn({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API}/public/portal/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(errorMessage(await res.json().catch(() => null), res.status));
      setSentTo(email.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card narrow" aria-labelledby="signin-title">
      <h1 id="signin-title">My requests</h1>
      {sentTo ? (
        <div role="status">
          <p>
            <strong>Check your email.</strong> If we have requests from <strong>{sentTo}</strong>,
            we've sent a sign-in link there. It works once and expires in {PORTAL_LINK_MINUTES}{' '}
            minutes.
          </p>
          <p className="muted">
            Nothing after a few minutes? Check the address, or{' '}
            <button type="button" className="link-button" onClick={() => setSentTo(null)}>
              try again
            </button>
            .
          </p>
        </div>
      ) : (
        <form className="form" onSubmit={submit} aria-label="Sign in">
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
          <p className="muted">
            Enter the email address you wrote to us from. We'll send you a link to see your
            requests: there is no password.
          </p>
          <div className="field">
            <label htmlFor="portal-email">Email address</label>
            <input
              id="portal-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="button button--primary" disabled={busy}>
              {busy ? 'Sending…' : 'Email me a link'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function Verify({ token, onSignedIn }: { token: string; onSignedIn: (s: PortalSession) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  // The link works once: don't spend it twice when the effect re-runs.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch(`${API}/public/portal/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (res.ok) onSignedIn(body as PortalSession);
        else setProblem(errorMessage(body, res.status));
      })
      .catch(() => setProblem('We could not sign you in. Please try again.'));
  }, [token, onSignedIn]);

  return (
    <section className="card narrow" aria-labelledby="verify-title">
      <h1 id="verify-title">My requests</h1>
      {problem ? (
        <>
          <p className="notice" role="alert">
            {problem}
          </p>
          <p>
            <a href={hrefFor({ page: 'portal' })}>Ask for a new link</a>
          </p>
        </>
      ) : (
        <p className="muted">Signing you in…</p>
      )}
    </section>
  );
}

function useLoad<T>(token: string, path: string, onExpired: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    portalApi<T>(token, 'GET', path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: Error) => (err instanceof SignedOut ? onExpired() : setError(err.message)));
  }, [token, path, onExpired]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  return { data, setData, error };
}

function TicketList({
  token,
  name,
  onExpired,
}: {
  token: string;
  name: string;
  onExpired: () => void;
}) {
  const { data, error } = useLoad<PortalTicketSummary[]>(token, '/portal/tickets', onExpired);
  return (
    <section className="card" aria-labelledby="list-title">
      <h1 id="list-title">My requests</h1>
      <p className="muted">
        {name ? `Hello ${name}. ` : ''}Everything you've asked us, by email, chat, phone or this
        site.
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data?.length === 0 && (
        <p>
          You have no requests yet. <a href="#/">Submit a request</a>.
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="requests" aria-label="Your requests">
          {data.map((t) => (
            <li key={t.reference}>
              <a
                href={hrefFor({ page: 'ticket', reference: t.reference })}
                className="request"
                data-reference={t.reference}
              >
                <span className="request__subject">{t.subject}</span>
                <span className="request__meta">
                  {t.reference} · {CHANNEL_LABELS[t.channel] ?? t.channel} · updated{' '}
                  {dateTime(t.updatedAt)}
                  {t.rating ? ` · you rated it ${t.rating}/5` : ''}
                </span>
                <span className="status" data-status={t.status}>
                  {PORTAL_STATUS_LABELS[t.status]}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TicketDetail({
  token,
  reference,
  onExpired,
}: {
  token: string;
  reference: string;
  onExpired: () => void;
}) {
  const path = `/portal/tickets/${encodeURIComponent(reference)}`;
  const { data: ticket, setData, error } = useLoad<PortalTicketDetail>(token, path, onExpired);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setReplyError(null);
    setSent(false);
    try {
      setData(await portalApi<PortalTicketDetail>(token, 'POST', `${path}/reply`, { body: reply }));
      setReply('');
      setSent(true);
    } catch (err) {
      if (err instanceof SignedOut) onExpired();
      else setReplyError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: number, comment: string) => {
    try {
      return await portalApi<CsatView>(token, 'POST', `${path}/rating`, { rating, comment });
    } catch (err) {
      if (err instanceof SignedOut) onExpired();
      throw err;
    }
  };

  /** Files need the session too, so they are fetched and handed to the browser as a download. */
  const download = async (messageId: string, index: number, filename: string) => {
    const res = await fetch(`${API}${path}/messages/${messageId}/attachments/${index}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) return onExpired();
    if (!res.ok) return setReplyError('That file could not be downloaded.');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card" aria-labelledby="detail-title">
      <p>
        <a href={hrefFor({ page: 'portal' })}>← All my requests</a>
      </p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!ticket && !error && <p className="muted">Loading…</p>}
      {ticket && (
        <>
          <h1 id="detail-title">{ticket.subject}</h1>
          <p className="request__meta">
            <strong data-reference>{ticket.reference}</strong> ·{' '}
            {CHANNEL_LABELS[ticket.channel] ?? ticket.channel} · opened {dateTime(ticket.createdAt)}{' '}
            <span className="status" data-status={ticket.status}>
              {PORTAL_STATUS_LABELS[ticket.status]}
            </span>
          </p>

          {ticket.messages.length === 0 ? (
            <p className="muted">There are no messages on this request yet.</p>
          ) : (
            <ol className="thread" aria-label="Messages">
              {ticket.messages.map((m) => (
                <li key={m.id} className="message" data-from={m.from}>
                  <p className="message__head">
                    <strong>{authorLabel(m)}</strong>
                    <time dateTime={m.createdAt}>{dateTime(m.createdAt)}</time>
                  </p>
                  <p className="message__body">{m.body}</p>
                  {m.attachments.length > 0 && (
                    <ul className="files">
                      {m.attachments.map((a) => (
                        <li key={a.index}>
                          <button
                            type="button"
                            className="link-button files__name"
                            onClick={() => void download(m.id, a.index, a.filename)}
                          >
                            {a.filename}
                          </button>
                          <span className="files__size">{formatBytes(a.size)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}

          {ticket.canRate && (
            <section className="panel" aria-label="Rating">
              <RatingForm key={ticket.reference} current={ticket.rating} onSubmit={rate} />
            </section>
          )}

          {ticket.canReply ? (
            <form className="form" onSubmit={send} aria-label="Reply">
              <div className="field">
                <label htmlFor="portal-reply">
                  {ticket.status === 'resolved' ? 'Not solved? Tell us more' : 'Add a reply'}
                </label>
                <textarea
                  id="portal-reply"
                  rows={4}
                  maxLength={5000}
                  value={reply}
                  onChange={(e) => {
                    setReply(e.target.value);
                    setSent(false);
                  }}
                  required
                />
                <p className="hint">
                  We'll answer by email, and the answer will show here too.
                  {ticket.status === 'resolved' ? ' Replying reopens the request.' : ''}
                </p>
              </div>
              {replyError && (
                <p className="field-error" role="alert">
                  {replyError}
                </p>
              )}
              {sent && (
                <p className="hint" role="status">
                  Your reply was added.
                </p>
              )}
              <div className="actions">
                <button type="submit" className="button button--primary" disabled={busy}>
                  {busy ? 'Sending…' : 'Send reply'}
                </button>
              </div>
            </form>
          ) : (
            <p className="muted">
              This request is closed. <a href="#/">Submit a new request</a> if you need more help.
            </p>
          )}
        </>
      )}
    </section>
  );
}
