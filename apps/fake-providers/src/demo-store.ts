/**
 * "Demo Store systems": a fictional order, payment and customer database that
 * the sample MCP server exposes as tools (ADR 0013). Everything here is made
 * up. State (refunds) lives in memory and resets when the service restarts.
 *
 * Every tool takes the customer's `email` and only answers about that
 * customer's own orders; TMS fills `email` from the ticket, never the model.
 *
 * Sandbox shoppers: any address at `shopper.example` owns any order numbered
 * DS-9xxxx, created on first use (delivered, charged twice). Tests and demos
 * use them to get a fresh customer with a refundable order every time.
 */

export interface Order {
  id: string;
  email: string;
  placedAt: string;
  status: 'processing' | 'shipped' | 'delivered' | 'returned';
  carrier: string | null;
  tracking: string | null;
  estimatedDelivery: string | null;
  items: Array<{ name: string; qty: number; price: number }>;
  currency: string;
  charges: Array<{ id: string; amount: number; at: string }>;
}

export interface Refund {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  reason: string;
  status: 'issued';
  issuedAt: string;
}

const SANDBOX = /@shopper\.example$/;
const SANDBOX_ORDER = /^DS-9\d{4}$/;

const CUSTOMERS: Record<string, { name: string; tier: 'standard' | 'vip'; since: string }> = {
  'maria.lopez@example.com': { name: 'María López', tier: 'standard', since: '2024-12-01' },
  'kenji.watanabe@example.org': { name: 'Kenji Watanabe', tier: 'vip', since: '2023-02-11' },
  'bea.sandoval@example.com': { name: 'Bea Sandoval', tier: 'standard', since: '2024-03-02' },
  'omar.farouk@example.org': { name: 'Omar Farouk', tier: 'vip', since: '2022-11-17' },
  'tom.whitaker@example.com': { name: 'Tom Whitaker', tier: 'standard', since: '2025-06-09' },
  'lena.fischer@example.org': { name: 'Lena Fischer', tier: 'standard', since: '2025-01-22' },
  'chidi.eze@example.com': { name: 'Chidi Eze', tier: 'standard', since: '2023-08-30' },
  'diego.paredes@example.net': { name: 'Diego Paredes', tier: 'vip', since: '2021-05-14' },
  'hana.sato@example.net': { name: 'Hana Sato', tier: 'standard', since: '2025-09-01' },
};

const ORDERS: Order[] = [
  {
    id: 'DS-10421',
    email: 'bea.sandoval@example.com',
    placedAt: '2026-09-24',
    status: 'shipped',
    carrier: 'Northwind Parcel',
    tracking: 'NW-7731-0042',
    estimatedDelivery: '2026-10-02',
    items: [{ name: 'Trail running shoes', qty: 1, price: 89.9 }],
    currency: 'EUR',
    charges: [{ id: 'ch_1042', amount: 89.9, at: '2026-09-24' }],
  },
  {
    id: 'DS-73310',
    email: 'omar.farouk@example.org',
    placedAt: '2026-09-28',
    status: 'processing',
    carrier: null,
    tracking: null,
    estimatedDelivery: '2026-10-04',
    items: [{ name: 'Cargo bike rain cover', qty: 1, price: 44.5 }],
    currency: 'EUR',
    charges: [{ id: 'ch_7331', amount: 44.5, at: '2026-09-28' }],
  },
  {
    id: 'DS-10388',
    email: 'tom.whitaker@example.com',
    placedAt: '2026-09-12',
    status: 'delivered',
    carrier: 'Northwind Parcel',
    tracking: 'NW-7731-0017',
    estimatedDelivery: null,
    items: [{ name: 'Commuter helmet', qty: 1, price: 59.9 }],
    currency: 'EUR',
    // Charged twice by mistake: the demo refund case.
    charges: [
      { id: 'ch_1038a', amount: 59.9, at: '2026-09-12' },
      { id: 'ch_1038b', amount: 59.9, at: '2026-09-12' },
    ],
  },
  {
    id: 'DS-48213',
    email: 'lena.fischer@example.org',
    placedAt: '2026-09-20',
    status: 'delivered',
    carrier: 'Northwind Parcel',
    tracking: 'NW-7731-0031',
    estimatedDelivery: null,
    items: [{ name: 'Rain jacket (S)', qty: 1, price: 129.0 }],
    currency: 'EUR',
    charges: [{ id: 'ch_4821', amount: 129.0, at: '2026-09-20' }],
  },
  {
    id: 'DS-80114',
    email: 'chidi.eze@example.com',
    placedAt: '2026-09-18',
    status: 'delivered',
    carrier: 'Harbor Express',
    tracking: 'HX-55-80114',
    estimatedDelivery: null,
    items: [{ name: 'Tablet 10"', qty: 1, price: 249.0 }],
    currency: 'EUR',
    charges: [{ id: 'ch_8011', amount: 249.0, at: '2026-09-18' }],
  },
  {
    id: 'DS-77421',
    email: 'diego.paredes@example.net',
    placedAt: '2026-09-05',
    status: 'returned',
    carrier: 'Harbor Express',
    tracking: 'HX-55-77421',
    estimatedDelivery: null,
    items: [{ name: 'Bike lights set', qty: 1, price: 34.9 }],
    currency: 'EUR',
    charges: [{ id: 'ch_7742', amount: 34.9, at: '2026-09-05' }],
  },
  {
    id: 'DS-20517',
    email: 'maria.lopez@example.com',
    placedAt: '2026-09-26',
    status: 'shipped',
    carrier: 'Harbor Express',
    tracking: 'HX-55-20517',
    estimatedDelivery: '2026-10-03',
    items: [{ name: 'Waterproof panniers', qty: 1, price: 74.0 }],
    currency: 'EUR',
    charges: [{ id: 'ch_2051', amount: 74.0, at: '2026-09-26' }],
  },
  {
    id: 'DS-20533',
    email: 'kenji.watanabe@example.org',
    placedAt: '2026-09-27',
    status: 'delivered',
    carrier: 'Northwind Parcel',
    tracking: 'NW-7731-0077',
    estimatedDelivery: null,
    items: [{ name: 'Folding lock', qty: 1, price: 39.9 }],
    currency: 'EUR',
    charges: [
      { id: 'ch_2053a', amount: 39.9, at: '2026-09-27' },
      { id: 'ch_2053b', amount: 39.9, at: '2026-09-27' },
    ],
  },
];

let sandboxOrders: Order[] = [];
let refunds: Refund[] = [];
let refundSeq = 5000;

export class DemoStoreError extends Error {}

const norm = (email: string) => email.trim().toLowerCase();

function sandboxOrder(id: string, email: string): Order {
  const order: Order = {
    id,
    email,
    placedAt: '2026-09-29',
    status: 'delivered',
    carrier: 'Northwind Parcel',
    tracking: `NW-9${id.slice(-4)}`,
    estimatedDelivery: null,
    items: [{ name: 'Sandbox rain jacket', qty: 1, price: 49.0 }],
    currency: 'EUR',
    charges: [
      { id: `ch_${id}_a`, amount: 49.0, at: '2026-09-29' },
      { id: `ch_${id}_b`, amount: 49.0, at: '2026-09-29' },
    ],
  };
  sandboxOrders.push(order);
  return order;
}

function ownOrder(orderId: string, email: string): Order {
  const id = orderId.trim().toUpperCase();
  let order = [...ORDERS, ...sandboxOrders].find((o) => o.id === id);
  if (!order && SANDBOX.test(norm(email)) && SANDBOX_ORDER.test(id)) {
    order = sandboxOrder(id, norm(email));
  }
  // The same answer for "no such order" and "not yours", so nothing leaks.
  if (!order || order.email !== norm(email)) {
    throw new DemoStoreError(`No order ${orderId} was found for this customer`);
  }
  return order;
}

const charged = (o: Order) => o.charges.reduce((sum, c) => sum + c.amount, 0);
const refunded = (o: Order) =>
  refunds.filter((r) => r.orderId === o.id).reduce((sum, r) => sum + r.amount, 0);
const round = (n: number) => Math.round(n * 100) / 100;

export function lookupCustomer(email: string) {
  const c =
    CUSTOMERS[norm(email)] ??
    (SANDBOX.test(norm(email))
      ? { name: 'Sandbox shopper', tier: 'standard' as const, since: '2026-09-29' }
      : undefined);
  if (!c) throw new DemoStoreError('No Demo Store account uses this email address');
  return {
    name: c.name,
    tier: c.tier,
    customer_since: c.since,
    orders: [...ORDERS, ...sandboxOrders]
      .filter((o) => o.email === norm(email))
      .map((o) => ({
        order_id: o.id,
        placed_at: o.placedAt,
        status: o.status,
      })),
  };
}

export function orderStatus(orderId: string, email: string) {
  const o = ownOrder(orderId, email);
  return {
    order_id: o.id,
    status: o.status,
    placed_at: o.placedAt,
    carrier: o.carrier,
    tracking_number: o.tracking,
    estimated_delivery: o.estimatedDelivery,
    items: o.items,
  };
}

export function paymentStatus(orderId: string, email: string) {
  const o = ownOrder(orderId, email);
  const total = round(o.items.reduce((sum, i) => sum + i.qty * i.price, 0));
  return {
    order_id: o.id,
    currency: o.currency,
    order_total: total,
    charges: o.charges,
    charged_total: round(charged(o)),
    refunds: refunds.filter((r) => r.orderId === o.id),
    duplicate_charge: charged(o) > total + 0.001,
  };
}

/** Refunds up to what was charged and not yet refunded; defaults to any overcharge, else the order total. */
export function issueRefund(
  orderId: string,
  email: string,
  amount: number | undefined,
  reason: string,
) {
  const o = ownOrder(orderId, email);
  const total = o.items.reduce((sum, i) => sum + i.qty * i.price, 0);
  const refundable = round(charged(o) - refunded(o));
  const overcharge = round(charged(o) - total - refunded(o));
  const value = round(amount ?? (overcharge > 0 ? overcharge : refundable));
  if (value <= 0) throw new DemoStoreError('Nothing left to refund on this order');
  if (value > refundable) {
    throw new DemoStoreError(`At most ${refundable.toFixed(2)} ${o.currency} can be refunded`);
  }
  const refund: Refund = {
    id: `RF-${refundSeq++}`,
    orderId: o.id,
    amount: value,
    currency: o.currency,
    reason: reason.slice(0, 200),
    status: 'issued',
    issuedAt: new Date().toISOString(),
  };
  refunds.push(refund);
  return {
    refund_id: refund.id,
    order_id: o.id,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
    arrives_in: '5 to 7 business days on the original card',
  };
}

/** Tests only. */
export function resetDemoStore() {
  sandboxOrders = [];
  refunds = [];
  refundSeq = 5000;
}
