/**
 * Knowledge-base retrieval check: runs the labelled questions in
 * kb/eval.json against a running TMS (loaded with `pnpm sample:load`) and
 * reports recall@5, meaning how often the expected document and section is
 * in the top five results.
 *
 *   pnpm kb:eval                  # uses whatever embedding model Settings assigns
 *   pnpm kb:eval -- --min 0.8     # exit 1 below the threshold
 *
 * With the scripted demo embeddings this measures the pipeline; with a real
 * embedding model it measures retrieval quality.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { min: { type: 'string', default: '0' } } });
const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';

interface Hit {
  title: string;
  section: string | null;
}

async function main() {
  const login = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { accessToken } = (await login.json()) as { accessToken: string };

  const { questions } = JSON.parse(
    readFileSync(new URL('./kb/eval.json', import.meta.url), 'utf8'),
  ) as { questions: Array<{ q: string; doc: string; section?: string }> };

  let hits = 0;
  let mode = '';
  for (const item of questions) {
    const url = `${API_URL}/api/v1/kb/search?${new URLSearchParams({ q: item.q, limit: '5', audience: 'customer' })}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { mode: string; hits: Hit[] };
    mode = body.mode;
    const rank = body.hits.findIndex(
      (h) => h.title === item.doc && (!item.section || (h.section ?? '').endsWith(item.section)),
    );
    if (rank >= 0) hits++;
    console.log(`${rank >= 0 ? `✓ #${rank + 1}` : '✗   '}  ${item.q}`);
  }
  const recall = hits / questions.length;
  console.log(
    `\nrecall@5 = ${recall.toFixed(2)} (${hits}/${questions.length}), search mode: ${mode}`,
  );
  if (recall < Number(values.min)) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
