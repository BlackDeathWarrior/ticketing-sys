import type { Channel, CurrentUser, OverviewReport, Permission, TicketHandling } from '@tms/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, hasSession, logout, qs } from './api/client';
import { closeAgentSocket, useAgentEvents } from './api/realtime';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { StarField } from './components/ui';
import {
  type ApiTicket,
  type ApiWorkflow,
  isOpenCategory,
  toTicket,
  toWorkflow,
} from './data/adapters';
import { viewById, type ViewId } from './data/views';
import { LoginPage } from './features/auth/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { NewTicketDialog } from './features/dashboard/NewTicketDialog';
import { TicketDrawer } from './features/dashboard/TicketDrawer';
import { ElementsPage } from './features/elements/ElementsPage';
import { KbPage } from './features/kb/KbPage';
import { LearningPage } from './features/learning/LearningPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { type Session, SessionContext } from './lib/session';
import { useGet } from './lib/useGet';
import { useHashRoute } from './lib/useHashRoute';
import styles from './App.module.css';
import { ApprovalsPage } from './features/tools/ApprovalsPage';

const ROUTE_TITLES = {
  dashboard: 'Overview',
  elements: 'Elements',
  settings: 'Settings',
  kb: 'Knowledge base',
  approvals: 'Approvals',
  reports: 'Reports',
  learning: 'Learning',
} as const;

/** Most tickets a list view loads at once (the API's page limit). */
const PAGE = 200;

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Restores the session from stored tokens, then shows the login page or the workspace. */
export function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(hasSession);

  useEffect(() => {
    if (!checking) return;
    api<CurrentUser>('GET', '/auth/me')
      .then(setUser)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, [checking]);

  useEffect(() => {
    const onLogout = () => {
      closeAgentSocket();
      setUser(null);
    };
    window.addEventListener('orbit:logout', onLogout);
    return () => window.removeEventListener('orbit:logout', onLogout);
  }, []);

  const signOut = useCallback(() => {
    void logout().finally(() => {
      closeAgentSocket();
      setUser(null);
    });
  }, []);

  if (checking) return null;
  if (!user) return <LoginPage onSignedIn={setUser} />;
  return <Workspace user={user} signOut={signOut} />;
}

function Workspace({ user, signOut }: { user: CurrentUser; signOut: () => void }) {
  const route = useHashRoute();
  const [view, setView] = useState<ViewId>('all');
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState<Channel | ''>('');
  const [handling, setHandling] = useState<TicketHandling | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [liveTick, setLiveTick] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = useDebounced(search.trim(), 250);

  const can = useCallback((p: Permission) => user.permissions.includes(p), [user]);
  const apiWorkflow = useGet<ApiWorkflow>('/workflow');
  const workflow = useMemo(
    () => (apiWorkflow.data ? toWorkflow(apiWorkflow.data) : undefined),
    [apiWorkflow.data],
  );
  const session = useMemo<Session>(
    () => ({ user, workflow, can, signOut }),
    [user, workflow, can, signOut],
  );

  const openStatuses = useMemo(
    () => workflow?.statuses.filter((s) => isOpenCategory(s.category)).map((s) => s.key) ?? [],
    [workflow],
  );
  const ready = workflow !== undefined;
  const pathFor = (id: ViewId, extra: Record<string, string | number | undefined> = {}) =>
    ready ? `/tickets${qs({ ...viewById(id).query(openStatuses), ...extra })}` : null;

  const queue = useGet<{ items: ApiTicket[]; total: number }>(
    pathFor(view, {
      q,
      channel: channel || undefined,
      handling: handling || undefined,
      limit: PAGE,
    }),
  );
  const open = useGet<{ items: ApiTicket[]; total: number }>(
    ready ? `/tickets${qs({ status: openStatuses.join(','), limit: PAGE })}` : null,
  );
  const overview = useGet<OverviewReport>(can('report:read') ? '/reports/overview' : null);
  // Approvals are decided by the request's team (ADR 0031): anyone on a team may have some.
  const mayApprove =
    can('approval:approve') || can('ticket:any_team') || (user.teams?.length ?? 0) > 0;
  const approvals = useGet<Array<{ status: string }>>(
    mayApprove ? '/approvals?status=pending&limit=200' : null,
  );
  const pendingApprovals = mayApprove ? approvals.data?.length : undefined;
  const teams =
    useGet<Array<{ id: string; name: string; members: Array<{ id: string }> }>>('/teams');
  const countAll = useGet<{ total: number }>(pathFor('all', { limit: 1 }));
  const countMine = useGet<{ total: number }>(pathFor('mine', { limit: 1 }));
  const countUnassigned = useGet<{ total: number }>(pathFor('unassigned', { limit: 1 }));
  const countUrgent = useGet<{ total: number }>(pathFor('urgent', { limit: 1 }));
  const countSla = useGet<{ total: number }>(pathFor('sla', { limit: 1 }));

  const refreshers = [
    queue,
    open,
    overview,
    approvals,
    countAll,
    countMine,
    countUnassigned,
    countUrgent,
    countSla,
  ];
  const refresh = () => refreshers.forEach((r) => void r.reload());

  useAgentEvents((events) => {
    // Knowledge-base events concern the KB page, not the queue.
    if (events.every((e) => e.type.startsWith('kb.'))) return;
    refresh();
    setLiveTick((n) => n + 1);
  });

  // "/" jumps to search from anywhere that isn't already a text field. The box
  // is in the tickets card, so from another page the dashboard opens first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTyping(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const focus = () => {
          searchRef.current?.focus();
          searchRef.current?.scrollIntoView({ block: 'center' });
        };
        if (searchRef.current) focus();
        else {
          window.location.hash = '#/';
          setTimeout(focus, 80);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scrollToQueue = () =>
    requestAnimationFrame(() =>
      document.getElementById('queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );

  const selectView = (next: ViewId) => {
    setView(next);
    if (route !== 'dashboard') window.location.hash = '#/';
    setTimeout(scrollToQueue, route === 'dashboard' ? 0 : 60);
  };

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const toTickets = (items: ApiTicket[] | undefined) =>
    (items ?? []).map((t) => toTicket(t, workflow));

  return (
    <SessionContext.Provider value={session}>
      <div className={styles.shell}>
        <a href="#main" className={styles.skip}>
          Skip to content
        </a>
        <Sidebar
          route={route}
          view={view}
          onSelectView={selectView}
          open={menuOpen}
          onClose={closeMenu}
          counts={{
            all: countAll.data?.total,
            mine: countMine.data?.total,
            unassigned: countUnassigned.data?.total,
            urgent: countUrgent.data?.total,
            sla: countSla.data?.total,
          }}
          teams={teams.data ?? []}
          pendingApprovals={pendingApprovals}
        />

        <div className={styles.main}>
          <StarField className={styles.stars} />
          <TopBar
            title={ROUTE_TITLES[route]}
            onOpenMenu={() => setMenuOpen(true)}
            onNewTicket={() => setComposerOpen(true)}
            onOpenTicket={setSelectedId}
          />
          <main id="main" className={styles.content} tabIndex={-1}>
            {route === 'elements' ? (
              <ElementsPage />
            ) : route === 'settings' ? (
              <SettingsPage />
            ) : route === 'kb' ? (
              <KbPage />
            ) : route === 'approvals' ? (
              <ApprovalsPage liveTick={liveTick} onOpenTicket={setSelectedId} />
            ) : route === 'reports' ? (
              <ReportsPage onOpenTicket={setSelectedId} />
            ) : route === 'learning' ? (
              <LearningPage liveTick={liveTick} onOpenTicket={setSelectedId} />
            ) : (
              <DashboardPage
                queue={{
                  title: viewById(view).label,
                  tickets: toTickets(queue.data?.items),
                  total: queue.data?.total ?? 0,
                  loading: queue.loading || !ready,
                  error: queue.error,
                }}
                openTickets={toTickets(open.data?.items)}
                overview={overview.data}
                search={search}
                onSearch={setSearch}
                searchRef={searchRef}
                channel={channel}
                onChannel={setChannel}
                handling={handling}
                onHandling={setHandling}
                selectedId={selectedId}
                onOpenTicket={setSelectedId}
                onShowUrgent={() => selectView('urgent')}
                onClearFilters={() => {
                  setSearch('');
                  setChannel('');
                  setHandling('');
                  setView('all');
                }}
              />
            )}
          </main>
          <footer className={styles.footer}>
            Orbit Desk · ticketing for teams that think clearly
          </footer>
        </div>

        <TicketDrawer
          ticketId={selectedId}
          liveTick={liveTick}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
        <NewTicketDialog
          open={composerOpen}
          onClose={() => setComposerOpen(false)}
          onCreated={(id) => {
            setComposerOpen(false);
            setSelectedId(id);
            refresh();
          }}
        />
      </div>
    </SessionContext.Provider>
  );
}
