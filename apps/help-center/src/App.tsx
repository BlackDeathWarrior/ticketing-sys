import {
  brandInitials,
  DEFAULT_BRANDING,
  type WebFormConfig,
  type WebFormReceipt,
} from '@tms/shared';
import { useEffect, useRef, useState } from 'react';
import { Portal } from './Portal';
import { parseRoute, type Route } from './portal-logic';
import { RatePage } from './RatePage';
import { RequestForm } from './RequestForm';

interface ChatHandle {
  open(): void;
}
declare global {
  interface Window {
    TMSChat?: { init(options: { title?: string }): ChatHandle };
  }
}

/** Loads the chat widget served next to this page; the chat option hides if it can't load. */
function useChatWidget(): ChatHandle | null {
  const [chat, setChat] = useState<ChatHandle | null>(null);
  useEffect(() => {
    const script = document.createElement('script');
    script.src = '/widget/tms-chat.js';
    script.async = true;
    script.onload = () => {
      if (window.TMSChat) setChat(window.TMSChat.init({ title: 'Chat with Support' }));
    };
    document.body.appendChild(script);
    return () => script.remove();
  }, []);
  return chat;
}

function useFormConfig() {
  const [config, setConfig] = useState<WebFormConfig | null>(null);
  useEffect(() => {
    fetch('/api/v1/public/request-form')
      .then((r) => (r.ok ? (r.json() as Promise<WebFormConfig>) : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);
  return config;
}

/** The page named by the URL hash: links in our emails open the portal or the rating page. */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const chat = useChatWidget();
  const config = useFormConfig();
  const route = useRoute();
  const [receipt, setReceipt] = useState<WebFormReceipt | null>(null);
  const inPortal = route.page === 'portal' || route.page === 'verify' || route.page === 'ticket';
  // Who this help center speaks for (Settings → Customers). The page's own
  // title and description follow, once the setting has loaded.
  const branding = config?.branding ?? DEFAULT_BRANDING;
  useEffect(() => {
    if (!config) return;
    document.title = `${branding.companyName} Help`;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', `Get help from the ${branding.companyName} support team.`);
  }, [config, branding.companyName]);

  return (
    <>
      <header className="site-header">
        <div className="wrap site-header__inner">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true">
              {brandInitials(branding.companyName)}
            </span>
            {branding.companyName}
          </span>
          <span className="site-header__section">Help center</span>
          <nav className="site-nav" aria-label="Help center">
            <a href="#/" aria-current={route.page === 'home' ? 'page' : undefined}>
              Submit a request
            </a>
            <a href="#/portal" aria-current={inPortal ? 'page' : undefined}>
              My requests
            </a>
          </nav>
        </div>
      </header>

      <main className="wrap" id="main">
        {route.page === 'rate' ? (
          <RatePage token={route.token} />
        ) : route.page === 'portal' || route.page === 'verify' || route.page === 'ticket' ? (
          <Portal route={route} />
        ) : receipt ? (
          <Receipt receipt={receipt} onAnother={() => setReceipt(null)} />
        ) : (
          <>
            <section className="intro" aria-labelledby="intro-title">
              <h1 id="intro-title">How can we help?</h1>
              <p className="lead">
                Chat with us for quick questions, or send a request and we'll reply by email.
              </p>
            </section>

            <div className="layout">
              <section className="card form-card" aria-labelledby="form-title">
                <h2 id="form-title">Submit a request</h2>
                <p className="muted">
                  Fields marked <span aria-hidden="true">*</span>
                  <span className="sr-only">with an asterisk</span> are required.
                </p>
                <RequestForm config={config} onSubmitted={setReceipt} />
              </section>

              <aside className="side">
                {chat && (
                  <section className="card" aria-labelledby="chat-title">
                    <h2 id="chat-title">Chat with us</h2>
                    <p className="muted">Our assistant answers most questions straight away.</p>
                    <button type="button" className="button button--secondary" onClick={chat.open}>
                      Start a chat
                    </button>
                  </section>
                )}
                <section className="card" aria-labelledby="tips-title">
                  <h2 id="tips-title">Before you write</h2>
                  <ul className="tips">
                    {branding.referenceLabel && (
                      <li>
                        Include your {branding.referenceLabel.toLowerCase()} if the request is about
                        one.
                      </li>
                    )}
                    <li>Photos or screenshots help us sort things out faster.</li>
                    <li>You'll get a reference by email; reply to it to add details.</li>
                  </ul>
                </section>
                <section className="card" aria-labelledby="mine-title">
                  <h2 id="mine-title">Already wrote to us?</h2>
                  <p className="muted">See your requests, add a reply or rate how we did.</p>
                  <a className="button button--secondary" href="#/portal">
                    My requests
                  </a>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>

      {branding.helpCenterNote && (
        <footer className="site-footer">
          <div className="wrap">{branding.helpCenterNote}</div>
        </footer>
      )}
    </>
  );
}

function Receipt({ receipt, onAnother }: { receipt: WebFormReceipt; onAnother: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    heading.current?.focus();
  }, []);
  return (
    <section className="card receipt" aria-labelledby="receipt-title">
      <h1 id="receipt-title" ref={heading} tabIndex={-1}>
        Request received
      </h1>
      <p className="reference">
        Your reference is <strong data-reference>{receipt.reference}</strong>
      </p>
      <p>
        We've sent a confirmation to <strong>{receipt.email}</strong>. Our reply will come to the
        same address. To add details or files, reply to that email, or follow it under{' '}
        <a href="#/portal">My requests</a>.
      </p>
      <button type="button" className="button button--secondary" onClick={onAnother}>
        Submit another request
      </button>
    </section>
  );
}
