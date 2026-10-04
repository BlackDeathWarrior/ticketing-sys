import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chatCompletion, type ChatRequest, embed } from './llm';
import { resetDemoStore } from './demo-store';
import { handleMcp } from './mcp';

/**
 * Fake external providers for offline demos and tests. Never point real
 * customer traffic at this: every answer is scripted.
 *
 *   POST /v1/chat/completions   OpenAI-compatible scripted LLM
 *   POST /v1/embeddings         deterministic embeddings
 *   GET  /v1/models
 *   POST /mcp                   sample MCP server: fictional Demo Store orders and payments
 *   POST /demo-store/reset      forget refunds made through the sample server (tests, demo resets)
 *   GET  /health
 */
const PORT = Number(process.env.PORT ?? 4010);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });

    if (req.method === 'POST' && url.pathname === '/demo-store/reset') {
      resetDemoStore();
      return send(res, 200, { status: 'reset' });
    }

    if (url.pathname === '/mcp') {
      return await handleMcp(req, res, req.method === 'POST' ? await readJson(req) : undefined);
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return send(res, 200, {
        object: 'list',
        data: ['scripted-cheap', 'scripted-premium', 'scripted-embed', 'always-fails'].map(
          (id) => ({
            id,
            object: 'model',
            owned_by: 'tms-fake',
          }),
        ),
      });
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = (await readJson(req)) as ChatRequest;
      if (body.model?.includes('always-fails')) {
        return send(res, 500, { error: { message: 'Scripted failure', type: 'server_error' } });
      }
      return send(res, 200, chatCompletion(body));
    }

    if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
      const body = (await readJson(req)) as {
        model: string;
        input: string | string[];
        dimensions?: number;
        encoding_format?: 'float' | 'base64';
      };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return send(res, 200, {
        object: 'list',
        model: body.model,
        data: inputs.map((text, index) => ({
          object: 'embedding',
          index,
          embedding:
            body.encoding_format === 'base64'
              ? Buffer.from(new Float32Array(embed(text, body.dimensions)).buffer).toString(
                  'base64',
                )
              : embed(text, body.dimensions),
        })),
        usage: { prompt_tokens: inputs.join(' ').length, total_tokens: inputs.join(' ').length },
      });
    }

    send(res, 404, { error: { message: `No fake for ${req.method} ${url.pathname}` } });
  } catch (err) {
    send(res, 400, { error: { message: (err as Error).message } });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`fake providers listening on :${PORT}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
