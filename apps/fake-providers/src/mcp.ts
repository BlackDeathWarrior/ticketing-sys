import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  DemoStoreError,
  issueRefund,
  lookupCustomer,
  orderStatus,
  paymentStatus,
} from './demo-store';

/**
 * The sample MCP server ("Demo Store systems") at /mcp, over streamable HTTP
 * in stateless mode: a fresh server per request. It needs
 * `Authorization: Bearer <FAKE_MCP_TOKEN>`; the token is a placeholder for
 * demos, not a secret.
 */
export const FAKE_MCP_TOKEN = process.env.FAKE_MCP_TOKEN ?? 'demo-store-token';

const email = { type: 'string', format: 'email', description: "The customer's email address" };
const orderId = {
  type: 'string',
  minLength: 3,
  maxLength: 20,
  description: 'Order number, e.g. DS-10421',
};

export const DEMO_STORE_TOOLS: Tool[] = [
  {
    name: 'lookup_customer',
    title: 'Look up customer',
    description: "The customer's Demo Store account: tier, since when, and their orders.",
    inputSchema: { type: 'object', properties: { email }, required: ['email'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'order_status',
    title: 'Order status',
    description:
      'Status of one of the customer’s orders: processing, shipped, delivered or returned, with carrier, tracking number and estimated delivery.',
    inputSchema: {
      type: 'object',
      properties: { order_id: orderId, email },
      required: ['order_id', 'email'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'payment_status',
    title: 'Payment status',
    description:
      'Charges and refunds on one of the customer’s orders, and whether they were charged more than the order total.',
    inputSchema: {
      type: 'object',
      properties: { order_id: orderId, email },
      required: ['order_id', 'email'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'issue_refund',
    title: 'Issue refund',
    description:
      'Refund money to the card used for one of the customer’s orders. Without an amount it refunds any duplicate charge, otherwise the rest of the order.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: orderId,
        email,
        amount: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 10_000,
          description: 'Amount to refund',
        },
        reason: {
          type: 'string',
          minLength: 3,
          maxLength: 200,
          description: 'Why, in a short sentence',
        },
      },
      required: ['order_id', 'email', 'reason'],
    },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
];

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Runs a Demo Store tool; the arguments were already checked against its schema by TMS. */
export function runDemoStoreTool(name: string, a: Record<string, unknown>): unknown {
  switch (name) {
    case 'lookup_customer':
      return lookupCustomer(str(a.email));
    case 'order_status':
      return orderStatus(str(a.order_id), str(a.email));
    case 'payment_status':
      return paymentStatus(str(a.order_id), str(a.email));
    case 'issue_refund':
      return issueRefund(
        str(a.order_id),
        str(a.email),
        typeof a.amount === 'number' ? a.amount : undefined,
        str(a.reason) || 'Customer request',
      );
    default:
      throw new DemoStoreError(`Unknown tool ${name}`);
  }
}

function build(): Server {
  const server = new Server(
    { name: 'demo-store-systems', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: DEMO_STORE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const data = runDemoStoreTool(req.params.name, req.params.arguments ?? {}) as Record<
        string,
        unknown
      >;
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (err) {
      if (err instanceof DemoStoreError) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
      throw err;
    }
  });
  return server;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown) {
  if (req.headers.authorization !== `Bearer ${FAKE_MCP_TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or wrong token' }));
    return;
  }
  if (req.method !== 'POST') {
    // Stateless: no server-initiated stream and no sessions to delete.
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  const server = build();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
