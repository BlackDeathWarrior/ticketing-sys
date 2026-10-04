/**
 * Runs the AI agent's golden conversations (apps/api/test/evals/*.yaml)
 * against a running TMS through POST /ai/simulate, using whatever models
 * Settings assigns. With the scripted demo model this checks the pipeline;
 * with real providers it measures answer quality. Nothing is stored or sent.
 *
 *   pnpm ai:eval
 *
 * Env: API_URL (http://localhost:3000), ADMIN_EMAIL / ADMIN_PASSWORD.
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  type AiGolden,
  checkAiGolden,
  goldenToSimulation,
  type SimulateAiResult,
} from '@tms/shared';
import { parse } from 'yaml';

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'ChangeMe123!';
const DIR = new URL('../../apps/api/test/evals/', import.meta.url);

async function main() {
  const login = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const { accessToken } = (await login.json()) as { accessToken: string };

  const goldens = readdirSync(DIR)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => parse(readFileSync(new URL(f, DIR), 'utf8')) as AiGolden[]);

  let failed = 0;
  for (const g of goldens) {
    const res = await fetch(`${API_URL}/api/v1/ai/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(goldenToSimulation(g)),
    });
    if (!res.ok) throw new Error(`simulate failed: ${res.status} ${await res.text()}`);
    const r = (await res.json()) as SimulateAiResult;
    const problems = checkAiGolden(g, r);
    if (problems.length) failed++;
    console.log(
      `${problems.length ? '✗' : '✓'} ${g.name}  [${r.decision}, ${r.confidence ?? '–'}, ${r.model ?? 'no model'}]`,
    );
    for (const p of problems) console.log(`    ${p}`);
  }
  console.log(`\n${goldens.length - failed}/${goldens.length} golden conversations passed`);
  if (failed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
