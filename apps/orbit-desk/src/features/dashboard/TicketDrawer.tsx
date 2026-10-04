import {
  AI_CLOSURE_LABELS,
  canActOnTeam,
  type CopilotSuggestion,
  type MessageCard,
  type Permission,
  PRIORITIES,
  waWindow,
} from '@tms/shared';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadFile } from '../../api/client';
import {
  type ApiConversation,
  type ApiNote,
  type ApiRef,
  type ApiTicket,
  channelLabels,
  deliveryLabel,
  minutesSince,
  nextStatuses,
  replyTarget,
  toThread,
  toTicket,
} from '../../data/adapters';
import type { Attachment, Priority, Ticket } from '../../data/types';
import { cx, fileSize, relativeTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import {
  AiActivity,
  aiClass,
  AiMark,
  aiMetaClass,
  ClassificationChips,
  DraftReview,
} from '../ai/AiParts';
import { aiMetaText } from '../ai/logic';
import { KbSearch } from '../kb/KbSearch';
import { ControlBar } from '../handover/ControlBar';
import { laneRows } from '../handover/logic';
import { HandoverContext, History, RatingPanel, SlaPanel } from '../handover/Panels';
import { TicketContext } from '../integrations/TicketContext';
import { ToolCalls } from '../tools/ToolCalls';
import { CallPanel } from '../voice/CallPanel';
import { windowNote } from '../whatsapp/logic';
import { TemplateComposer } from '../whatsapp/TemplateComposer';
import kbStyles from '../kb/Kb.module.css';
import { useGet } from '../../lib/useGet';
import { CustomerFlags } from './CustomerFlags';
import { CustomerPhone } from './CustomerPhone';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Icon,
  Select,
  StatusGlyph,
  StatusPill,
  Tabs,
  Textarea,
  priorityLabels,
} from '../../components/ui';
import styles from './TicketDrawer.module.css';

interface TicketDrawerProps {
  ticketId: string | null;
  /** Bumped by live events so an open drawer refreshes. */
  liveTick: number;
  onClose: () => void;
  /** Called after any change, so lists and counts refresh. */
  onChanged: () => void;
}

/** Highlight @mentions in the accent color (DESIGN.md › Testimonial Card). */
/** A message's files; downloads go through the API with the agent's token. */
function AttachmentList({ files }: { files: Attachment[] }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ul className={styles.attachments} aria-label="Attachments">
        {files.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className={styles.attachment}
              onClick={() => {
                setError(null);
                downloadFile(f.path, f.filename).catch((e: Error) => setError(e.message));
              }}
            >
              <Icon name="paperclip" size={14} />
              <span className={styles.attachmentName}>{f.filename}</span>
              <span className={styles.attachmentSize}>{fileSize(f.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className={styles.hint} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The picture cards a WhatsApp reply carried. Titles, texts and pictures come from the
 * company's app: the text is rendered as text, and the picture is fetched without a referrer.
 */
function CardList({ cards, dropped }: { cards: MessageCard[]; dropped: boolean }) {
  return (
    <>
      <p className={styles.cardsNote}>
        {dropped ? 'Cards not shown; the items were listed as text' : 'Cards sent with this reply'}
      </p>
      <ul className={styles.cards} aria-label="Cards shown">
        {cards.map((c) => (
          <li key={c.id} className={styles.card}>
            <img
              className={styles.cardImage}
              src={c.imageUrl}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            <div className={styles.cardText}>
              <span className={styles.cardTitle}>{c.title}</span>
              {c.text && <span className={styles.cardBody}>{c.text}</span>}
              {c.url && <span className={styles.cardBody}>{c.url}</span>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** How a reply on each conversation reaches the customer. Web-form tickets are answered by email. */
const REPLY_VIA: Record<string, string> = {
  webchat: 'web chat',
  web_form: 'email',
  whatsapp: 'WhatsApp',
  api: 'a message in the app',
};

function withMentions(text: string) {
  return text.split(/(@\w+)/g).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className={styles.mention}>
        {part}
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

export function TicketDrawer({ ticketId, liveTick, onClose, onChanged }: TicketDrawerProps) {
  return (
    <Dialog open={ticketId !== null} onClose={onClose} variant="drawer" labelledBy="drawer-title">
      {ticketId && (
        <DrawerLoader
          key={ticketId}
          ticketId={ticketId}
          liveTick={liveTick}
          onClose={onClose}
          onChanged={onChanged}
        />
      )}
    </Dialog>
  );
}

function DrawerLoader({
  ticketId,
  liveTick,
  onClose,
  onChanged,
}: TicketDrawerProps & { ticketId: string }) {
  const { workflow } = useSession();
  const ticket = useGet<ApiTicket>(`/tickets/${ticketId}`);
  const conversations = useGet<ApiConversation[]>(`/tickets/${ticketId}/conversations`);
  const notes = useGet<ApiNote[]>(`/tickets/${ticketId}/notes`);
  const { reload: reloadTicket } = ticket;
  const { reload: reloadConversations } = conversations;
  const { reload: reloadNotes } = notes;

  const reload = useCallback(
    () => Promise.all([reloadTicket(), reloadConversations(), reloadNotes()]),
    [reloadTicket, reloadConversations, reloadNotes],
  );
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);

  if (ticket.error) {
    return (
      <div className={styles.header} role="alert">
        <p>{ticket.error}</p>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  if (!ticket.data || !workflow) {
    return (
      <div className={styles.header} aria-busy="true">
        <p className={styles.hint}>Loading ticket…</p>
      </div>
    );
  }
  return (
    <DrawerContent
      ticket={toTicket(ticket.data, workflow)}
      conversations={conversations.data ?? []}
      notes={notes.data ?? []}
      liveTick={liveTick}
      onClose={onClose}
      onChanged={async () => {
        await reload();
        onChanged();
      }}
    />
  );
}

function DrawerContent({
  ticket,
  conversations,
  notes,
  liveTick,
  onClose,
  onChanged,
}: {
  ticket: Ticket;
  conversations: ApiConversation[];
  notes: ApiNote[];
  liveTick: number;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { user, workflow, can: canAnywhere } = useSession();
  // Another team's ticket (ADR 0031): read it and add notes; its team does the rest.
  const ownTeam = canActOnTeam(user, ticket.team?.id);
  const can = (p: Permission) => canAnywhere(p) && (ownTeam || p === 'ticket:note');
  const thread = useMemo(
    () => toThread(ticket, conversations, notes),
    [ticket, conversations, notes],
  );
  const target = replyTarget(thread);
  // A voice call is answered by talking (the call panel), not by typing.
  const canReply =
    can('message:send') &&
    target?.channel !== 'voice' &&
    (target !== null || !!ticket.customer.email);
  // With no conversation yet, a customer with a phone number can be written to on WhatsApp,
  // but only with an approved template.
  const canStartWhatsApp = can('message:send') && !target && !!ticket.customer.phone;
  const wa = target?.channel === 'whatsapp' ? waWindow(target.lastInboundAt) : null;
  type Mode = 'reply' | 'template' | 'note';
  const [mode, setModeState] = useState<Mode>(canReply ? 'reply' : 'note');
  const [modeChosen, setModeChosen] = useState(false);
  const setMode = (m: Mode) => {
    setModeChosen(true);
    setModeState(m);
  };
  // Conversations can arrive after the ticket: switch to replying once that's possible,
  // unless the agent already picked a mode.
  useEffect(() => {
    if (canReply && !modeChosen) setModeState('reply');
  }, [canReply, modeChosen]);
  const [draft, setDraft] = useState('');
  const [layout, setLayout] = useState<'timeline' | 'lanes'>('timeline');
  const [suggesting, setSuggesting] = useState(false);

  /** Copilot: fills the composer with a suggested reply to edit. */
  const suggest = async () => {
    setSuggesting(true);
    setError(undefined);
    try {
      const r = await api<CopilotSuggestion>('POST', `/tickets/${ticket.id}/copilot`, {});
      setMode('reply');
      setDraft(r.suggestion);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuggesting(false);
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const users = useGet<Array<ApiRef & { isActive: boolean }>>(
    can('ticket:assign') && can('user:read') ? '/users' : null,
  );
  const teams = useGet<ApiRef[]>(can('ticket:assign') ? '/teams' : null);

  const allowed = workflow ? nextStatuses(workflow, ticket.status.key) : [];
  const statusOptions = [ticket.status, ...allowed];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    const ok = await run(() => {
      if (mode === 'note') return api('POST', `/tickets/${ticket.id}/notes`, { body });
      if (target) return api('POST', `/conversations/${target.id}/messages`, { body });
      return api('POST', `/tickets/${ticket.id}/conversations`, { channel: 'email', body });
    });
    if (ok) setDraft('');
  };

  const replyVia = target ? (REPLY_VIA[target.channel] ?? target.channel) : 'email';

  const sendTemplate = (input: unknown) =>
    run(() =>
      target
        ? api('POST', `/conversations/${target.id}/whatsapp-template`, input)
        : api('POST', `/tickets/${ticket.id}/conversations`, {
            channel: 'whatsapp',
            template: input,
          }),
    );
  // WhatsApp refuses free text once its 24-hour window has closed: offer templates instead.
  const showTemplates = mode === 'template' || (mode === 'reply' && wa !== null && !wa.open);

  return (
    <>
      <header className={styles.header}>
        <div className={styles.topline}>
          <span className={styles.id}>{ticket.reference}</span>
          <StatusPill status={ticket.status.glyph} label={ticket.status.name} />
          <span className={styles.spacer} />
          <Button variant="ghost" size="sm" icon="x" iconOnly onClick={onClose} autoFocus>
            Close ticket panel
          </Button>
        </div>
        <h2 id="drawer-title" className={styles.title}>
          {ticket.subject}
        </h2>
        <ControlBar ticket={ticket} target={target} onChanged={() => void onChanged()} />
        {!ownTeam && (
          <p className={styles.otherTeam} role="note">
            This ticket belongs to the {ticket.team?.name} team. You can read it and add internal
            notes; only that team can reply, change or take it over.
          </p>
        )}
        {ticket.tags.length > 0 && (
          <div className={styles.tags}>
            {ticket.tags.map((tag) => (
              <Badge key={tag}>#{tag}</Badge>
            ))}
          </div>
        )}
      </header>

      <div className={styles.scroll}>
        {ticket.aiClassification && (
          <ClassificationChips classification={ticket.aiClassification} />
        )}
        <section className={styles.controls} aria-label="Ticket properties">
          <div className={styles.statusGroup} role="radiogroup" aria-label="Status">
            {statusOptions.map((s) => (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={ticket.status.key === s.key}
                disabled={busy || !can('ticket:transition')}
                className={cx(
                  styles.statusOption,
                  ticket.status.key === s.key && styles.statusActive,
                )}
                onClick={() => {
                  if (s.key !== ticket.status.key)
                    void run(() =>
                      api('POST', `/tickets/${ticket.id}/transition`, { status: s.key }),
                    );
                }}
              >
                <StatusGlyph status={s.glyph} />
                {s.name}
              </button>
            ))}
          </div>

          <div className={styles.selects}>
            <Select
              id="drawer-priority"
              label="Priority"
              value={ticket.priority}
              disabled={busy || !can('ticket:update')}
              onChange={(e) =>
                void run(() =>
                  api('PATCH', `/tickets/${ticket.id}`, { priority: e.target.value as Priority }),
                )
              }
              options={PRIORITIES.map((p) => ({ value: p, label: priorityLabels[p] }))}
            />
            {users.data ? (
              <Select
                id="drawer-assignee"
                label="Assignee"
                value={ticket.assignee?.id ?? ''}
                disabled={busy}
                onChange={(e) =>
                  void run(() =>
                    api('POST', `/tickets/${ticket.id}/assign`, {
                      assigneeId: e.target.value || null,
                    }),
                  )
                }
                options={[
                  { value: '', label: 'Unassigned' },
                  ...users.data
                    .filter((u) => u.isActive || u.id === ticket.assignee?.id)
                    .map((u) => ({
                      value: u.id,
                      label: u.id === user.id ? `${u.name} (you)` : u.name,
                    })),
                ]}
              />
            ) : (
              <div className={styles.readonly}>
                <span className={styles.readonlyLabel}>Assignee</span>
                <span>{ticket.assignee?.name ?? 'Unassigned'}</span>
              </div>
            )}
          </div>

          <dl className={styles.meta}>
            <div>
              <dt>Customer</dt>
              <dd className={styles.customerCell}>
                <Avatar initials={ticket.customer.initials} size={20} />
                {ticket.customer.name}
              </dd>
            </div>
            <CustomerPhone
              customerId={ticket.customer.id}
              phone={ticket.customer.phone}
              liveTick={liveTick}
            />
            <div>
              <dt>Company</dt>
              <dd>
                {ticket.customer.company ?? '—'}{' '}
                <span className={styles.plan}>{ticket.customer.plan}</span>
              </dd>
            </div>
            <div>
              <dt>Channel</dt>
              <dd>{channelLabels[ticket.channel] ?? ticket.channel}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{ticket.categoryLabel ?? '—'}</dd>
            </div>
            {ticket.aiClosure && (
              <div data-ai-closure={ticket.aiClosure}>
                <dt>Closure</dt>
                <dd>{AI_CLOSURE_LABELS[ticket.aiClosure]}</dd>
              </div>
            )}
            <div>
              <dt>Team</dt>
              <dd>
                {teams.data ? (
                  <Select
                    id="drawer-team"
                    label="Team"
                    hideLabel
                    value={ticket.team?.id ?? ''}
                    disabled={busy}
                    onChange={(e) =>
                      void run(() =>
                        api('POST', `/tickets/${ticket.id}/assign`, {
                          teamId: e.target.value,
                        }),
                      )
                    }
                    options={[
                      ...(ticket.team ? [] : [{ value: '', label: 'No team yet' }]),
                      ...teams.data.map((t) => ({ value: t.id, label: t.name })),
                    ]}
                  />
                ) : (
                  (ticket.team?.name ?? '—')
                )}
              </dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd title={ticket.customer.email ?? undefined}>{ticket.customer.email ?? '—'}</dd>
            </div>
            <div>
              <dt>Opened</dt>
              <dd className="tabular">{relativeTime(minutesSince(ticket.createdAt))}</dd>
            </div>
          </dl>
          <CustomerFlags customerId={ticket.customer.id} liveTick={liveTick} />
        </section>

        <TicketContext ticket={ticket} liveTick={liveTick} />
        <CallPanel ticketId={ticket.id} liveTick={liveTick} onChanged={() => void onChanged()} />
        <SlaPanel ticketId={ticket.id} liveTick={liveTick} />
        <RatingPanel ticketId={ticket.id} liveTick={liveTick} />
        <HandoverContext ticketId={ticket.id} liveTick={liveTick} />

        <section className={styles.thread} aria-label="Conversation">
          <div className={styles.threadHead}>
            <h3 className={styles.threadTitle}>Conversation</h3>
            {thread.messages.length > 0 && (
              <Tabs
                label="Conversation layout"
                value={layout}
                onChange={setLayout}
                items={[
                  { value: 'timeline' as const, label: 'Timeline' },
                  { value: 'lanes' as const, label: 'AI | People' },
                ]}
              />
            )}
          </div>
          {thread.messages.length === 0 ? (
            <p className={styles.hint}>No messages yet.</p>
          ) : (
            <ol className={cx(styles.messages, layout === 'lanes' && styles.lanes)}>
              {layout === 'lanes' && (
                <li className={styles.laneHeads} aria-hidden="true">
                  <span>AI</span>
                  <span>People</span>
                </li>
              )}
              {laneRows(thread.messages).map((row, i) => {
                if (row.type === 'switch') {
                  return layout === 'lanes' ? (
                    <li key={`switch-${i}`} className={styles.laneSwitch} data-switch={row.to}>
                      {row.to === 'human' ? 'A person took over' : 'Back with the AI'}
                    </li>
                  ) : null;
                }
                const m = row.message;
                return (
                  <li
                    key={m.id}
                    className={cx(
                      styles.message,
                      styles[m.kind],
                      m.byAi && m.delivery !== 'draft' && aiClass,
                    )}
                    data-kind={m.kind}
                    data-lane={row.lane}
                    data-ai={m.byAi || undefined}
                  >
                    <Avatar
                      initials={m.initials}
                      size={32}
                      highlight={m.authorId === user.id || m.byAi}
                    />
                    <div className={styles.bubble}>
                      <p className={styles.author}>
                        <span>{m.author}</span>
                        {m.byAi && <AiMark />}
                        {m.kind === 'note' && (
                          <span className={styles.noteLabel}>Internal note</span>
                        )}
                        {m.viaPortal && <span className={styles.noteLabel}>From the portal</span>}
                        {deliveryLabel(m.delivery) && (
                          <span className={styles.noteLabel} data-delivery={m.delivery}>
                            {deliveryLabel(m.delivery)}
                          </span>
                        )}
                        <time className={styles.time} dateTime={m.at.toISOString()}>
                          {relativeTime(minutesSince(m.at))}
                        </time>
                      </p>
                      <p className={styles.body}>{withMentions(m.body)}</p>
                      {m.cards && m.cards.length > 0 && (
                        <CardList cards={m.cards} dropped={!!m.cardsDropped} />
                      )}
                      {m.cardsDropped && (
                        <p className={styles.cardsNote} role="note">
                          Sent as text: {m.cardsDropped}
                        </p>
                      )}
                      {m.attachments.length > 0 && <AttachmentList files={m.attachments} />}
                      {m.transcript !== undefined && (
                        <p className={styles.cardsNote} role="note" data-transcript>
                          {m.transcript
                            ? `Voice message, written down by the AI: “${m.transcript}”`
                            : 'Voice message: the AI could not make out what is said.'}
                        </p>
                      )}
                      {m.delivery === 'failed' && m.deliveryError && (
                        <p className={styles.deliveryError} role="note">
                          {m.deliveryError}
                        </p>
                      )}
                      {m.delivery === 'draft' ? (
                        <DraftReview
                          messageId={m.id}
                          body={m.body}
                          confidence={m.ai?.confidence ?? null}
                          onChanged={onChanged}
                        />
                      ) : (
                        m.ai && <p className={aiMetaClass}>{aiMetaText(m.ai)}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <ToolCalls ticketId={ticket.id} liveTick={liveTick} />

        <AiActivity ticketId={ticket.id} liveTick={liveTick} />
        <History ticketId={ticket.id} liveTick={liveTick} />

        {can('kb:read') && (
          <section className={kbStyles.panel} aria-label="Knowledge base">
            <h3 className={kbStyles.panelTitle}>Knowledge base</h3>
            <KbSearch
              id={`kb-drawer-${ticket.id}`}
              initialQuery={ticket.subject}
              limit={3}
              onInsert={
                canReply
                  ? (text) => {
                      setMode('reply');
                      setDraft((d) => (d.trim() ? `${d.trimEnd()}\n\n${text}` : text));
                    }
                  : undefined
              }
            />
          </section>
        )}
      </div>

      <form className={styles.composer} onSubmit={send}>
        <div className={styles.composerTop}>
          <Tabs
            label="Message type"
            value={mode}
            onChange={setMode}
            items={[
              ...(canReply ? [{ value: 'reply' as const, label: 'Reply to customer' }] : []),
              ...(canStartWhatsApp
                ? [{ value: 'template' as const, label: 'WhatsApp template' }]
                : []),
              { value: 'note' as const, label: 'Internal note' },
            ]}
          />
        </div>
        {showTemplates ? (
          <TemplateComposer
            reason={windowNote(wa ?? waWindow(null))}
            busy={busy}
            onSend={sendTemplate}
          />
        ) : (
          <>
            {mode === 'reply' && wa && <p className={styles.windowNote}>{windowNote(wa)}</p>}
            <label htmlFor="composer" className="visually-hidden">
              {mode === 'reply' ? `Reply to ${ticket.customer.name}` : 'Internal note'}
            </label>
            <Textarea
              id="composer"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                mode === 'reply'
                  ? `Reply to ${ticket.customer.name.split(' ')[0]} by ${replyVia}…`
                  : 'Add a note for your team — use @name to mention'
              }
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(e);
              }}
            />
          </>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {!showTemplates && (
          <div className={styles.composerFoot}>
            <span className={styles.hint}>
              <Icon name="sparkle" size={14} /> ⌘ Enter to send
            </span>
            {canReply && (
              <Button
                variant="ghost"
                size="sm"
                icon="sparkle"
                disabled={suggesting}
                onClick={() => void suggest()}
              >
                {suggesting ? 'Suggesting…' : 'Suggest a reply'}
              </Button>
            )}
            <Button type="submit" variant="secondary" icon="send" disabled={!draft.trim() || busy}>
              {mode === 'reply' ? 'Send reply' : 'Add note'}
            </Button>
          </div>
        )}
      </form>
    </>
  );
}
