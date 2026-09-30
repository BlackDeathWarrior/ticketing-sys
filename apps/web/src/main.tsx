import type { CurrentUser } from '@tms/shared';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router';
import { api, hasSession, logout } from './api';
import { closeAgentSocket } from './realtime';
import { CustomerPage, CustomersPage } from './pages/customers';
import { LoginPage } from './pages/login';
import { NewTicketPage } from './pages/new-ticket';
import { TicketPage } from './pages/ticket';
import { TicketsPage } from './pages/tickets';

function App() {
  const [user, setUser] = useState<CurrentUser | null | undefined>(hasSession() ? undefined : null);
  const navigate = useNavigate();

  useEffect(() => {
    if (user === undefined) {
      api<CurrentUser>('GET', '/auth/me').then(setUser, () => setUser(null));
    }
    const onLogout = () => setUser(null);
    window.addEventListener('tms:logout', onLogout);
    return () => window.removeEventListener('tms:logout', onLogout);
  }, [user]);

  if (user === undefined) return <p>Loading…</p>;
  if (!user) return <LoginPage onLogin={setUser} />;

  return (
    <>
      <header>
        <nav>
          <strong>TMS</strong> | <Link to="/tickets">Tickets</Link> |{' '}
          <Link to="/tickets/new">New ticket</Link> | <Link to="/customers">Customers</Link> |{' '}
          {user.name} ({user.roles.join(', ')}){' '}
          <button
            onClick={async () => {
              await logout();
              closeAgentSocket();
              setUser(null);
              navigate('/');
            }}
          >
            Log out
          </button>
        </nav>
        <hr />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/tickets" replace />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/tickets/new" element={<NewTicketPage />} />
          <Route path="/tickets/:ref" element={<TicketPage user={user} />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:id" element={<CustomerPage />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
