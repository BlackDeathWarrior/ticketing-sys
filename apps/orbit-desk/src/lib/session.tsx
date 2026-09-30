import type { CurrentUser, Permission } from '@tms/shared';
import { createContext, useContext } from 'react';
import type { Workflow } from '../data/types';

export interface Session {
  user: CurrentUser;
  workflow: Workflow | undefined;
  can: (permission: Permission) => boolean;
  signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionContext');
  return session;
}
