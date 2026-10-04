import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { type Database, kbChunks, kbDocuments } from '@tms/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DB } from '../src/infra/tokens';
import { KbIndexerService } from '../src/kb/kb-indexer.service';
import { LlmClientService } from '../src/llm/llm-client.service';
import {
  clearKnowledgeBase,
  startApp,
  startWorker,
  type TestClient,
  uniq,
  waitFor,
} from './helpers';
import { makePdf } from './pdf-fixture';
import { FAKE_LLM_BASE_URL } from './test-env';

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let providerId: string;
let embedModelId: string;
const agents: Record<string, { token: string; id: string }> = {};
let teamIn: string;

const KB_DIR = path.resolve(__dirname, '../../../scripts/sample-data/kb');

/** Sends a multipart upload the way a browser form would. */
async function upload(
  file: { filename: string; contentType: string; content: Buffer },
  fields: Record<string, string> = {},
  url = '/kb/documents/upload',
  token = admin,
) {
  const boundary = `----tms${uniq()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat(parts),
  });
  return { status: res.statusCode, body: res.json() };
}

async function waitIndexed(id: string, state = 'indexed') {
  return waitFor(
    async () => {
      const r = await t.call('GET', `/kb/documents/${id}`, { token: admin });
      return r.body.indexState === state ? r.body : undefined;
    },
    `document ${id} to be ${state}`,
    30_000,
  );
}

async function search(q: string, opts: Record<string, string> = {}, token = admin) {
  const res = await t.call('GET', '/kb/search', { token, query: { q, ...opts } });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    mode: string;
    hits: Array<{
      documentId: string;
      title: string;
      section: string | null;
      similarity: number | null;
      matchedBy: string[];
      citation: { url: string | null; label: string };
    }>;
  };
}

async function approve(id: string) {
  const res = await t.call('POST', `/kb/documents/${id}/status`, {
    token: admin,
    body: { status: 'approved' },
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  await clearKnowledgeBase(t, admin);

  const p = await t.call('POST', '/settings/llm/providers', {
    token: admin,
    body: {
      provider: 'openai_compatible',
      label: `KB fake ${uniq()}`,
      apiKey: 'fake-kb-key-0000000000',
      baseUrl: FAKE_LLM_BASE_URL,
    },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  providerId = p.body.id;
  const embed = await t.call('POST', '/settings/llm/models', {
    token: admin,
    body: {
      providerId,
      model: 'scripted-embed',
      mode: 'embedding',
      inputCostPerMTok: 0.02,
      outputCostPerMTok: 0,
    },
  });
  expect(embed.status).toBe(201);
  embedModelId = embed.body.id;
  const role = await t.call('PUT', '/settings/llm/roles/embedding', {
    token: admin,
    body: { mode: 'ordered', modelIds: [embedModelId] },
  });
  expect(role.status, JSON.stringify(role.body)).toBe(200);
  // Indexing falls back to keyword search without an embedding model, so make
  // sure the router can use this one before any document is uploaded.
  await waitFor(async () => {
    const roles = (await t.call('GET', '/settings/llm/roles', { token: admin })).body as Array<{
      role: string;
      candidates: Array<{ skipped?: string | null }>;
    }>;
    return roles.find((r) => r.role === 'embedding')?.candidates.some((c) => !c.skipped);
  }, 'a usable embedding model');

  const team = await t.call('POST', '/teams', {
    token: admin,
    body: { name: `KB team ${uniq()}` },
  });
  teamIn = team.body.id;
  for (const [key, teamIds] of [
    ['inTeam', [teamIn]],
    ['outside', []],
  ] as const) {
    const email = `${uniq(key)}@test.local`;
    const res = await t.call('POST', '/users', {
      token: admin,
      body: { email, name: `KB ${key}`, password: 'Kb-Agent-Passw0rd!', roles: ['agent'], teamIds },
    });
    agents[key] = {
      id: res.body.id,
      token: (await t.login(email, 'Kb-Agent-Passw0rd!')).accessToken,
    };
  }
  worker = await startWorker();
}, 60_000);

afterAll(async () => {
  await worker?.close();
  if (providerId) await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
  await t?.close();
});

describe('knowledge base documents', () => {
  let pdfId: string;

  it('indexes an uploaded PDF, but only approved documents are searchable', async () => {
    const res = await upload(
      {
        filename: 'returns-policy.pdf',
        contentType: 'application/pdf',
        content: makePdf([
          'Returns policy',
          'You can return unused items within 30 days of delivery.',
        ]),
      },
      { visibility: 'public' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      source: 'file',
      status: 'draft',
      title: 'returns-policy',
      version: 1,
    });
    pdfId = res.body.id;

    const doc = await waitIndexed(pdfId);
    expect(doc).toMatchObject({ indexMode: 'hybrid', chunkCount: 1 });
    expect(doc.content).toContain('within 30 days');

    // Other test files may leave approved documents behind; this one must not be among the hits.
    const beforeApproval = (await search('return unused items within 30 days', { limit: '20' }))
      .hits;
    expect(beforeApproval.some((h) => h.documentId === pdfId)).toBe(false);
    const preview = await search('return unused items within 30 days', {
      includeDrafts: 'true',
      limit: '20',
    });
    expect(preview.hits.some((h) => h.documentId === pdfId)).toBe(true);

    await approve(pdfId);
    const found = await search('How many days to return unused items?', { limit: '20' });
    expect(found.mode).toBe('hybrid');
    const hit = found.hits.find((h) => h.documentId === pdfId)!;
    expect(hit).toBeDefined();
    expect(hit.matchedBy).toContain('vector');
    expect(hit.similarity).toBeGreaterThan(0);
    expect(hit.citation.url).toBe(`/api/v1/kb/documents/${pdfId}/file`);

    const file = await t.app.inject({
      method: 'GET',
      url: `/api/v1/kb/documents/${pdfId}/file`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
  });

  it('indexes a document once even when two jobs for it overlap', async () => {
    // A new version and a "re-index everything" can reach the same document together.
    // Both jobs are held at the embedding call, then let go at once while the test
    // holds the document's row, so their chunk swaps are certain to overlap.
    const database = t.app.get<Database>(DB);
    const indexer = worker.get(KbIndexerService);
    const llm = worker.get(LlmClientService);
    const embed = llm.embed.bind(llm);
    let waiting = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const spy = vi.spyOn(llm, 'embed').mockImplementation(async (...args) => {
      waiting++;
      await gate;
      return embed(...args);
    });
    try {
      const jobs = [indexer.index(pdfId, null), indexer.index(pdfId, null)];
      await waitFor(() => waiting === 2, 'both jobs to reach the embedding call');
      await database.transaction(async (tx) => {
        await tx
          .select({ id: kbDocuments.id })
          .from(kbDocuments)
          .where(eq(kbDocuments.id, pdfId))
          .for('update');
        open();
        // The row is held until both jobs are waiting for it: that is the overlap.
        await waitFor(async () => {
          const res = await database.execute<{ n: number }>(
            sql`select count(*)::int as n from pg_locks where not granted`,
          );
          return res.rows[0]!.n >= 2;
        }, 'both jobs to wait for the document');
      });
      await Promise.all(jobs);
    } finally {
      spy.mockRestore();
    }
    const chunks = await database
      .select({ id: kbChunks.id })
      .from(kbChunks)
      .where(eq(kbChunks.documentId, pdfId));
    expect(chunks).toHaveLength(1);
  });

  it('keeps customer-facing searches to public documents and respects team visibility', async () => {
    const make = async (title: string, visibility: string, teamId: string | null = null) => {
      const r = await t.call('POST', '/kb/documents', {
        token: admin,
        body: {
          source: 'faq',
          title,
          content: 'The zebra warehouse ships on Saturdays only.',
          visibility,
          teamId,
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await waitIndexed(r.body.id);
      await approve(r.body.id);
      return r.body.id as string;
    };
    const pub = await make('Public zebra warehouse note', 'public');
    const internal = await make('Internal zebra warehouse note', 'internal');
    const teamOnly = await make('Team zebra warehouse note', 'team', teamIn);

    const ids = (hits: Array<{ documentId: string }>) => new Set(hits.map((h) => h.documentId));
    const customer = ids(
      (await search('zebra warehouse saturdays', { audience: 'customer', limit: '10' })).hits,
    );
    expect(customer.has(pub)).toBe(true);
    expect(customer.has(internal)).toBe(false);
    expect(customer.has(teamOnly)).toBe(false);

    const inside = ids(
      (await search('zebra warehouse saturdays', { limit: '10' }, agents.inTeam!.token)).hits,
    );
    expect([...inside]).toEqual(expect.arrayContaining([pub, internal, teamOnly]));
    const outside = ids(
      (await search('zebra warehouse saturdays', { limit: '10' }, agents.outside!.token)).hits,
    );
    expect(outside.has(teamOnly)).toBe(false);
    expect(outside.has(internal)).toBe(true);

    // Agents can't open a team document they aren't in, or preview drafts.
    expect(
      (await t.call('GET', `/kb/documents/${teamOnly}`, { token: agents.outside!.token })).status,
    ).toBe(404);
  });

  it('re-indexes a new version and drops the old text', async () => {
    const r = await t.call('POST', '/kb/documents', {
      token: admin,
      body: {
        source: 'text',
        title: 'Gift wrapping',
        content: '# Gift wrapping\n\nGift wrapping costs 49 rupees per parcel.',
        visibility: 'public',
      },
    });
    await waitIndexed(r.body.id);
    await approve(r.body.id);
    expect((await search('gift wrapping 49 rupees')).hits[0]?.documentId).toBe(r.body.id);

    const upd = await t.call('PATCH', `/kb/documents/${r.body.id}`, {
      token: admin,
      body: { content: '# Gift wrapping\n\nGift wrapping is free on orders above 2000 rupees.' },
    });
    expect(upd.body.version).toBe(2);
    await waitFor(async () => {
      const d = await t.call('GET', `/kb/documents/${r.body.id}`, { token: admin });
      return d.body.indexState === 'indexed' &&
        d.body.chunkCount === 1 &&
        d.body.content.includes('free')
        ? d
        : undefined;
    }, 'version 2 to be indexed');
    const hits = (await search('gift wrapping 49 rupees', { limit: '10' })).hits.filter(
      (h) => h.documentId === r.body.id,
    );
    expect(hits.every((h) => !JSON.stringify(h).includes('49 rupees'))).toBe(true);

    const db = t.app.get<Database>(DB);
    const rows = await db.select().from(kbChunks).where(eq(kbChunks.documentId, r.body.id));
    expect(rows.map((c) => c.version)).toEqual([2]);
  });

  it('falls back to keyword search when no embedding model is available', async () => {
    await t.call('PATCH', `/settings/llm/models/${embedModelId}`, {
      token: admin,
      body: { enabled: false },
    });
    try {
      const r = await t.call('POST', '/kb/documents', {
        token: admin,
        body: {
          source: 'faq',
          title: 'Kayak racks',
          content: 'Kayak roof racks fit cars with rails.',
          visibility: 'public',
        },
      });
      const doc = await waitIndexed(r.body.id);
      expect(doc.indexMode).toBe('keyword');
      await approve(r.body.id);
      const res = await search('kayak roof racks');
      expect(res.mode).toBe('keyword');
      expect(res.hits[0]?.documentId).toBe(r.body.id);
    } finally {
      await t.call('PATCH', `/settings/llm/models/${embedModelId}`, {
        token: admin,
        body: { enabled: true },
      });
    }
  });

  it('rejects unsafe URLs, unsupported files and non-managers', async () => {
    for (const url of ['http://127.0.0.1:4010/kb', 'http://169.254.169.254/latest/meta-data']) {
      const r = await t.call('POST', '/kb/documents', {
        token: admin,
        body: { source: 'url', title: 'x', url },
      });
      expect(r.status, url).toBe(400);
    }
    const bad = await upload({
      filename: 'photo.png',
      contentType: 'image/png',
      content: Buffer.from('png'),
    });
    expect(bad.status).toBe(400);
    const agent = await t.call('POST', '/kb/documents', {
      token: agents.inTeam!.token,
      body: { source: 'faq', title: 'x', content: 'y' },
    });
    expect(agent.status).toBe(403);
    // An agent may still search: the helper fails on anything but 200.
    expect(Array.isArray((await search('anything', {}, agents.inTeam!.token)).hits)).toBe(true);
  });

  it('audits changes and deletes chunks with the document', async () => {
    const created = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'kb.document_created', targetId: pdfId },
    });
    expect(created.body).toHaveLength(1);
    const indexed = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'kb.document_indexed', targetId: pdfId },
    });
    expect(indexed.body[0].actorType).toBe('system');

    expect((await t.call('DELETE', `/kb/documents/${pdfId}`, { token: admin })).status).toBe(204);
    const db = t.app.get<Database>(DB);
    expect(await db.select().from(kbChunks).where(eq(kbChunks.documentId, pdfId))).toHaveLength(0);
    expect((await t.call('GET', `/kb/documents/${pdfId}`, { token: admin })).status).toBe(404);
  });
});

describe('retrieval quality on the sample knowledge base', () => {
  it('finds the right document and section in the top five for at least 80% of questions', async () => {
    const ids: string[] = [];
    for (const [file, type] of [
      ['returns-policy.md', 'text/markdown'],
      ['shipping-faq.md', 'text/markdown'],
      ['billing-faq.md', 'text/markdown'],
      ['account-help.html', 'text/html'],
    ] as const) {
      const r = await upload(
        { filename: file, contentType: type, content: readFileSync(path.join(KB_DIR, file)) },
        { visibility: 'public' },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ids.push(r.body.id);
    }
    const faqs = JSON.parse(readFileSync(path.join(KB_DIR, 'faq-hi.json'), 'utf8')) as Array<{
      question: string;
      answer: string;
    }>;
    for (const f of faqs) {
      const r = await t.call('POST', '/kb/documents', {
        token: admin,
        body: {
          source: 'faq',
          title: f.question,
          content: f.answer,
          visibility: 'public',
          language: 'hi',
        },
      });
      ids.push(r.body.id);
    }
    for (const id of ids) {
      await waitIndexed(id);
      await approve(id);
    }

    const { questions } = JSON.parse(readFileSync(path.join(KB_DIR, 'eval.json'), 'utf8')) as {
      questions: Array<{ q: string; doc: string; section?: string }>;
    };
    let hits = 0;
    const misses: string[] = [];
    for (const item of questions) {
      const res = await search(item.q, { limit: '5', audience: 'customer' });
      const ok = res.hits.some(
        (h) => h.title === item.doc && (!item.section || (h.section ?? '').endsWith(item.section)),
      );
      if (ok) hits++;
      else misses.push(item.q);
    }
    const recall = hits / questions.length;
    expect(recall, `missed: ${misses.join(' | ')}`).toBeGreaterThanOrEqual(0.8);
  }, 120_000);
});
