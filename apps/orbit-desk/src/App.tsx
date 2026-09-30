import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { StarField } from './components/ui';
import { tickets as seedTickets } from './data/mock';
import type { Ticket } from './data/types';
import type { ViewId } from './data/views';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { NewTicketDialog } from './features/dashboard/NewTicketDialog';
import { TicketDrawer } from './features/dashboard/TicketDrawer';
import { ElementsPage } from './features/elements/ElementsPage';
import { useHashRoute } from './lib/useHashRoute';
import styles from './App.module.css';

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function App() {
  const route = useHashRoute();
  const [tickets, setTickets] = useState<Ticket[]>(seedTickets);
  const [view, setView] = useState<ViewId>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" jumps to search from anywhere that isn't already a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !isTyping(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
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

  const updateTicket = useCallback((id: string, patch: Partial<Ticket>) => {
    setTickets((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const createTicket = (draft: Omit<Ticket, 'id'>) => {
    const next = Math.max(...tickets.map((t) => Number(t.id.split('-')[1]))) + 1;
    const id = `TCK-${next}`;
    setTickets((all) => [{ ...draft, id }, ...all]);
    setComposerOpen(false);
    setSelectedId(id);
  };

  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
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
      />

      <div className={styles.main}>
        <StarField className={styles.stars} />
        <TopBar
          ref={searchRef}
          title={route === 'elements' ? 'Elements' : 'Overview'}
          search={search}
          onSearch={(value) => {
            setSearch(value);
            if (value && route !== 'dashboard') window.location.hash = '#/';
          }}
          onOpenMenu={() => setMenuOpen(true)}
          onNewTicket={() => setComposerOpen(true)}
        />
        <main id="main" className={styles.content} tabIndex={-1}>
          {route === 'elements' ? (
            <ElementsPage />
          ) : (
            <DashboardPage
              tickets={tickets}
              view={view}
              search={search}
              selectedId={selectedId}
              onOpenTicket={setSelectedId}
              onSelectView={selectView}
              onClearFilters={() => {
                setSearch('');
                setView('all');
              }}
            />
          )}
        </main>
        <footer className={styles.footer}>
          Orbit Desk · ticketing for teams that think clearly
        </footer>
      </div>

      <TicketDrawer ticket={selected} onClose={() => setSelectedId(null)} onUpdate={updateTicket} />
      <NewTicketDialog
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        onCreate={createTicket}
      />
    </div>
  );
}
