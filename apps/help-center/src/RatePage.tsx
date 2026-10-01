import type { CsatPrompt, CsatView } from '@tms/shared';
import { useEffect, useState } from 'react';
import { errorMessage } from './logic';
import { RatingForm } from './RatingForm';

/** The page behind the link in the "How did we do?" email. The link rates one request. */
export function RatePage({ token }: { token: string }) {
  const [prompt, setPrompt] = useState<CsatPrompt | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const url = `/api/v1/public/csat/${encodeURIComponent(token)}`;

  useEffect(() => {
    let cancelled = false;
    setPrompt(null);
    setProblem(null);
    fetch(url)
      .then(async (r) => {
        const body: unknown = await r.json().catch(() => null);
        if (cancelled) return;
        if (r.ok) setPrompt(body as CsatPrompt);
        else
          setProblem(
            r.status === 404 ? 'This rating link is not valid.' : errorMessage(body, r.status),
          );
      })
      .catch(() => !cancelled && setProblem('We could not load this page. Please try again.'));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const submit = async (rating: number, comment: string): Promise<CsatView> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating, comment }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(errorMessage(body, res.status));
    return body as CsatView;
  };

  return (
    <section className="card narrow" aria-labelledby="rate-title">
      <h1 id="rate-title">Rate your request</h1>
      {problem && (
        <>
          <p className="notice" role="alert">
            {problem}
          </p>
          <p>
            <a href="#/portal">See my requests</a> or <a href="#/">submit a new request</a>.
          </p>
        </>
      )}
      {!problem && !prompt && <p className="muted">Loading…</p>}
      {prompt && (
        <>
          <p className="reference">
            <strong data-reference>{prompt.reference}</strong> · {prompt.subject}
          </p>
          <RatingForm current={prompt.rating} onSubmit={submit} />
        </>
      )}
    </section>
  );
}
