import { AGENT_NAMESPACE } from '@tms/shared';
import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { accessToken } from './client';

export interface AgentEvent {
  type: string;
  ticketId?: string;
  conversationId?: string;
  messageId?: string;
  documentId?: string;
}

let socket: Socket | null = null;

/** One shared /agent socket; authenticates with the current access token. */
export function agentSocket(): Socket {
  socket ??= io(AGENT_NAMESPACE, {
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
 * Calls `onEvent` for ticket and message events pushed by the server, debounced
 * so a burst (reply + status change + delivery) triggers one refresh.
 */
export function useAgentEvents(onEvent: (e: AgentEvent) => void, enabled = true) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    const s = agentSocket();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: AgentEvent | undefined;
    const listener = (e: AgentEvent) => {
      last = e;
      clearTimeout(timer);
      timer = setTimeout(() => handler.current(last!), 250);
    };
    s.on('event', listener);
    return () => {
      clearTimeout(timer);
      s.off('event', listener);
    };
  }, [enabled]);
}
