import { AGENT_NAMESPACE } from '@tms/shared';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { accessToken, refreshSession } from './client';

export interface AgentEvent {
  type: string;
  ticketId?: string;
  conversationId?: string;
  messageId?: string;
  documentId?: string;
}

let socket: Socket | null = null;

/**
 * One shared /agent socket; authenticates with the current access token.
 *
 * The token lasts minutes and the socket hours. When the socket has to
 * reconnect (a network blip, an API restart) with a token that has expired
 * since, the server closes it, and socket.io does not retry a connection the
 * server closed. Without this the console went quiet until a reload: so get
 * a fresh token and connect again.
 */
export function agentSocket(): Socket {
  if (socket) return socket;
  const s = io(AGENT_NAMESPACE, {
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: accessToken() }),
  });
  let retry: ReturnType<typeof setTimeout> | undefined;
  s.on('disconnect', (reason) => {
    if (reason !== 'io server disconnect') return;
    clearTimeout(retry);
    retry = setTimeout(async () => {
      // Signed out meanwhile, or the session really is over: stay closed.
      if (socket !== s || !(await refreshSession())) return;
      s.connect();
    }, 1000);
  });
  socket = s;
  return s;
}

export function closeAgentSocket() {
  socket?.disconnect();
  socket = null;
}

/** How long the tab must have been away before coming back to it counts as "catch up". */
const AWAY_MS = 30_000;

/**
 * Calls `onEvents` for ticket and message events pushed by the server,
 * debounced so a burst (reply + status change + delivery) triggers one
 * refresh. It gets the whole burst: a caller that only looked at the last
 * event missed a new ticket whenever something unrelated arrived right
 * after it.
 *
 * A `live.resumed` event stands for "anything may have changed": the socket
 * came back after being disconnected, or the tab was looked at again after a
 * while. Events sent in between are gone, so callers refetch.
 */
export function useAgentEvents(onEvents: (events: AgentEvent[]) => void, enabled = true) {
  const handler = useRef(onEvents);
  handler.current = onEvents;

  useEffect(() => {
    if (!enabled) return;
    const s = agentSocket();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let burst: AgentEvent[] = [];
    const listener = (e: AgentEvent) => {
      burst.push(e);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const events = burst;
        burst = [];
        handler.current(events);
      }, 250);
    };
    const resumed = () => listener({ type: 'live.resumed' });
    let connectedBefore = s.connected;
    const onConnect = () => {
      if (connectedBefore) resumed();
      connectedBefore = true;
    };
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > AWAY_MS) resumed();
    };
    s.on('event', listener);
    s.on('connect', onConnect);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      s.off('event', listener);
      s.off('connect', onConnect);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}
