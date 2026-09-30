import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { accessToken } from './api';

export interface AgentEvent {
  type: string;
  ticketId?: string;
  conversationId?: string;
  messageId?: string;
}

let socket: Socket | null = null;

/** One shared /agent socket for the console; authenticates with the current access token. */
function agentSocket(): Socket {
  socket ??= io('/agent', {
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: accessToken() }),
  });
  return socket;
}

export function closeAgentSocket() {
  socket?.disconnect();
  socket = null;
}

/**
 * Calls `onEvent` for ticket/message events pushed by the server, debounced
 * so a burst of events (reply + status change + delivery) triggers one refresh.
 */
export function useAgentEvents(
  onEvent: (e: AgentEvent) => void,
  filter?: (e: AgentEvent) => boolean,
) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const accept = useRef(filter);
  accept.current = filter;

  useEffect(() => {
    const s = agentSocket();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: AgentEvent | undefined;
    const listener = (e: AgentEvent) => {
      if (accept.current && !accept.current(e)) return;
      last = e;
      clearTimeout(timer);
      timer = setTimeout(() => handler.current(last!), 250);
    };
    s.on('event', listener);
    return () => {
      clearTimeout(timer);
      s.off('event', listener);
    };
  }, []);
}
