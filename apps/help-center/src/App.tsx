import type { WebFormConfig, WebFormReceipt } from '@tms/shared';
import { useEffect, useRef, useState } from 'react';
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

export function App() {
  const chat = useChatWidget();
  const config = useFormConfig();
  const [receipt, setReceipt] = useState<WebFormReceipt | null>(null);

  return (
    <>
      <header className="site-header">
        <div className="wrap site-header__inner">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true">
              DS
            </span>
            Demo Store
          </span>
          <span className="site-header__section">Help center</span>
        </div>
      </header>

      <main className="wrap" id="main">
        {receipt ? (
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
                    <li>Include your order number if the request is about an order.</li>
                    <li>Photos or screenshots help us sort things out faster.</li>
                    <li>You'll get a reference by email; reply to it to add details.</li>
                  </ul>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>

      <footer className="site-footer">
        <div className="wrap">Demo Store is a fictional shop used to demonstrate TMS.</div>
      </footer>
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
        same address. To add details or files, reply to that email.
      </p>
      <button type="button" className="button button--secondary" onClick={onAnother}>
        Submit another request
      </button>
    </section>
  );
}
