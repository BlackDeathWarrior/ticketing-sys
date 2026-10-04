/**
 * The support desk of Ethnic Threads, the demonstration shop in the
 * garment-web-scraper repository: what `load-garment.ts` sets up in a running
 * TMS so the shop can use it (ADR 0027, ADR 0028).
 *
 * The staff are invented and use the reserved `.example` domain. The
 * knowledge base in ./kb says what the shop really does: its delivery
 * charges, its cancellation and return rules, how refunds work.
 */

/** The integration's identifier: the widget, the keys and the webhook hang off it. */
export const INTEGRATION = { slug: 'ethnic-threads', name: 'Ethnic Threads' };

export const branding = {
  companyName: 'Ethnic Threads',
  supportName: 'Ethnic Threads Support',
  helpCenterNote:
    'Ethnic Threads is a demonstration shop for Indian ethnic wear. No money is taken and nothing is shipped.',
  referenceLabel: 'Order number',
};

export const teams = [
  { name: 'Customer Care', description: 'Product questions, feedback and chat' },
  { name: 'Orders and Delivery', description: 'Where orders are, cancellations and returns' },
  { name: 'Payments', description: 'Failed payments, charges and refunds' },
  { name: 'Operations', description: 'The shop itself: checkout, the carrier, the site' },
];

export interface GarmentUser {
  key: string;
  name: string;
  email: string;
  roles: string[];
  teams: string[];
  /** Teams they are an admin of: they manage its members (ADR 0031). */
  admins?: string[];
  /** Whether routing may hand them tickets right away. */
  online: boolean;
}

export const users: GarmentUser[] = [
  {
    key: 'meera',
    name: 'Meera Iyer',
    email: 'meera.iyer@ethnicthreads.example',
    roles: ['team_lead'],
    teams: ['Customer Care'],
    admins: ['Customer Care'],
    online: true,
  },
  {
    key: 'arjun',
    name: 'Arjun Rao',
    email: 'arjun.rao@ethnicthreads.example',
    roles: ['agent'],
    teams: ['Customer Care'],
    online: true,
  },
  {
    key: 'kavya',
    name: 'Kavya Nair',
    email: 'kavya.nair@ethnicthreads.example',
    roles: ['agent'],
    teams: ['Orders and Delivery'],
    admins: ['Orders and Delivery'],
    online: true,
  },
  {
    key: 'nikhil',
    name: 'Nikhil Shah',
    email: 'nikhil.shah@ethnicthreads.example',
    roles: ['agent'],
    teams: ['Payments'],
    online: true,
  },
  {
    key: 'dev',
    name: 'Dev Malhotra',
    email: 'dev.malhotra@ethnicthreads.example',
    roles: ['agent'],
    teams: ['Operations'],
    admins: ['Operations'],
    online: true,
  },
  // Admin of Payments, the team that decides refunds (any of its members may).
  {
    key: 'farah',
    name: 'Farah Khan',
    email: 'farah.khan@ethnicthreads.example',
    roles: ['supervisor'],
    teams: ['Payments', 'Customer Care'],
    admins: ['Payments'],
    online: false,
  },
];

/**
 * Top-level names are what the shop sends as `category` with a ticket
 * (`shop/support.py` in the garment repo), so they must match.
 */
export const categories: Array<{ name: string; children: string[] }> = [
  {
    name: 'Orders and delivery',
    children: ['Where is my order', 'Cancellation', 'Delivery delay'],
  },
  {
    name: 'Returns and refunds',
    children: ['Return request', 'Refund status', 'Wrong or damaged item'],
  },
  { name: 'Payments', children: ['Payment failed', 'Charged twice'] },
  { name: 'Products', children: ['Size and fit', 'Availability'] },
  { name: 'Site problem', children: ['Sign-in', 'Page not loading'] },
  { name: 'Feedback', children: [] },
];

/**
 * Urgent tickets are timed in minutes so a breach can be seen happening in a
 * demo: a shopper who writes "urgent" and asks for a person must be answered
 * within two minutes, and so must a critical incident.
 */
export const sla = {
  hours: {
    name: 'Support hours (India)',
    timezone: 'Asia/Kolkata',
    schedule: [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '09:00', end: '21:00' })),
    holidays: [],
  },
  policies: [
    { name: 'Urgent', priority: 'urgent', firstResponseMinutes: 2, resolutionMinutes: 30 },
    { name: 'High', priority: 'high', firstResponseMinutes: 15, resolutionMinutes: 240 },
    { name: 'Standard', firstResponseMinutes: 240, resolutionMinutes: 2880, supportHours: true },
  ] as Array<{
    name: string;
    priority?: string;
    firstResponseMinutes: number;
    resolutionMinutes: number;
    supportHours?: boolean;
  }>,
};

/** First match wins. `category` is a top-level category name; `team` a team name. */
export const routing: Array<{
  name: string;
  conditions: { channel?: string; tag?: string };
  category?: string;
  team: string;
  strategy: 'least_loaded' | 'round_robin';
}> = [
  {
    name: 'Shop incidents',
    conditions: { tag: 'incident' },
    team: 'Operations',
    strategy: 'least_loaded',
  },
  {
    name: 'Orders and delivery',
    conditions: {},
    category: 'Orders and delivery',
    team: 'Orders and Delivery',
    strategy: 'least_loaded',
  },
  {
    name: 'Returns and refunds',
    conditions: {},
    category: 'Returns and refunds',
    team: 'Orders and Delivery',
    strategy: 'least_loaded',
  },
  {
    name: 'Payments',
    conditions: {},
    category: 'Payments',
    team: 'Payments',
    strategy: 'least_loaded',
  },
  {
    name: 'Everything else',
    conditions: {},
    team: 'Customer Care',
    strategy: 'round_robin',
  },
];

/**
 * The chat answers by itself; a request sent from a form is drafted for an
 * agent to approve, because the shopper is not waiting on the page.
 */
export const aiChannels = { webchat: 'auto', api: 'draft' } as const;

export const kb = {
  /**
   * Questions shoppers ask in these words, with the answer from the
   * documents below. Answered without a model when a question matches one
   * closely (ADR 0030); they say only what the documents say.
   */
  faqs: [
    {
      question: 'How much does delivery cost?',
      answer:
        'Standard delivery takes about 4 days and costs ₹49; it is free on orders of ₹499 or more. Express delivery takes about 2 days and costs ₹99 on every order.',
    },
    {
      question: 'How long does a refund take?',
      answer:
        'A refund goes to the payment method you used and reaches you in 5 to 7 business days; the order page shows its reference, which starts with "RF-". A cancelled order, or an order returned in full, is refunded in full. When you return only some of the items, you are refunded the price of those items; the delivery charge is not refunded.',
    },
    {
      question: 'How do I return an order?',
      answer:
        'You can return an order, or only some of its items, within 7 days of delivery: open it under "Your Orders", choose "Return items", pick how many of each item to send back and say what is wrong. Support can also do it for you on a call or in a chat. The return is accepted at once and the refund is made right away: nobody has to approve it. An order can be returned once. Items marked "Final sale" cannot be returned.',
    },
    {
      question: 'What does "Final sale" mean?',
      answer:
        'An item marked "Final sale" cannot be returned once it is delivered. The mark is shown on the product, in your cart, at checkout and on the order. You can still cancel the order before it ships. If a final-sale item arrives damaged or is not what you ordered, choose "Get help with this order" on the order page.',
    },
    {
      question: 'Can I cancel my order?',
      answer:
        'Yes, until it ships, that is while it is "Order placed" or "Packed": open the order under "Your Orders" and choose "Cancel order". If you had already paid, the full amount is refunded at once. An order that has shipped cannot be cancelled; return it once it arrives.',
    },
    {
      question: 'Which payment methods can I use?',
      answer:
        'Cash on delivery, UPI or card. With cash on delivery you pay when the order arrives; with UPI or card the order is paid when you place it.',
    },
    {
      question: 'Can I change my delivery address?',
      answer:
        'The address cannot be changed after the order is placed. If the order has not shipped yet, cancel it and order again with the right address.',
    },
  ],
  files: [
    'about-the-shop.md',
    'delivery.md',
    'cancellations-returns-refunds.md',
    'payments.md',
    'getting-help.md',
    'whatsapp.md',
  ],
  /** For agents and the copilot only: never shown or said to a shopper. */
  internal: {
    title: 'Shop incidents: what they mean and what to do',
    content: [
      '# Shop incidents: what they mean and what to do',
      '',
      'Incident tickets are opened by the shop itself. Repeats are counted on the same ticket; the ticket resolves by itself when the shop reports a recovery and no person has started on it.',
      '',
      '## Payments are failing at checkout',
      'Shoppers cannot pay by UPI or card; each failed checkout is one report. Cash on delivery still works. Check the payment provider, and tell shoppers who write in that they have not been charged.',
      '',
      '## Orders are delayed with the carrier',
      'Orders that have shipped are not moving. Shoppers see "Delayed with the carrier" on their order page. Nothing is lost: the orders move again when the carrier does.',
      '',
      '## Refunds',
      'The AI may cancel an order that has not shipped. It may only ask for a refund: the request waits under Approvals for a supervisor. Refunds are for delivered or returned orders that were paid for, always in full.',
    ].join('\n'),
  },
};

export interface GarmentTool {
  name: string;
  title: string;
  description: string;
  method: 'GET' | 'POST';
  /** Under the shop's /api/support/tools. */
  path: string;
  parameters: Array<{
    name: string;
    type: 'string' | 'integer';
    description: string;
    required: boolean;
  }>;
  /** Filled by TMS with the ticket customer's email, never by the model. */
  customerArg?: string;
  tier: 'read' | 'write' | 'transactional';
  /** The team that decides its requests, by name (ADR 0031). */
  approverTeam?: string;
}

const customer = {
  name: 'customer_email',
  type: 'string' as const,
  description: "The customer's email address",
  required: true,
};

/**
 * Custom HTTP tools (ADR 0017) that call the shop. Every order tool is bound
 * to the customer: TMS fills `customer_email` from the ticket, and the shop
 * answers only about that customer's orders. Looking up is free, cancelling
 * changes data, and a refund is `transactional`: it waits for a supervisor.
 * The cart tools are bound the same way: the shop keeps a signed-in shopper's
 * cart, so the AI can fill it on any channel, and nothing here checks out.
 */
export const tools: GarmentTool[] = [
  {
    name: 'order_status',
    title: 'Order status',
    description:
      "Where one of the customer's orders is: its status, carrier, tracking number, expected delivery date, total and payment. Use it when they give an order number (like ET-100123) or the ticket context has an order_id.",
    method: 'GET',
    path: '/orders/{order_id}',
    parameters: [
      {
        name: 'order_id',
        type: 'string',
        description: 'The order number, e.g. ET-100123',
        required: true,
      },
      customer,
    ],
    customerArg: 'customer_email',
    tier: 'read',
  },
  {
    name: 'list_orders',
    title: 'Recent orders',
    description:
      "The customer's five most recent orders with their status. Use it when they ask about an order without giving its number.",
    method: 'GET',
    path: '/orders',
    parameters: [customer],
    customerArg: 'customer_email',
    tier: 'read',
  },
  {
    name: 'payment_status',
    title: 'Payments',
    description:
      "The customer's failed checkouts (no order was made and nothing was charged) and how each recent order was paid or refunded. Use it first when they report a failed payment, a double charge or money taken without an order.",
    method: 'GET',
    path: '/payments',
    parameters: [customer],
    customerArg: 'customer_email',
    tier: 'read',
  },
  {
    name: 'cancel_order',
    title: 'Cancel an order',
    description:
      "Cancels one of the customer's orders. Only works before the order has shipped; what was paid is refunded at once. Use it only when the customer clearly asks to cancel that order.",
    method: 'POST',
    path: '/orders/{order_id}/cancel',
    parameters: [
      {
        name: 'order_id',
        type: 'string',
        description: 'The order number, e.g. ET-100123',
        required: true,
      },
      customer,
      { name: 'reason', type: 'string', description: 'Why, in a few words', required: false },
    ],
    customerArg: 'customer_email',
    tier: 'write',
  },
  {
    name: 'issue_refund',
    title: 'Refund an order',
    description:
      "Refunds one of the customer's delivered orders in full. Our Payments team decides each request. Use it when the customer asks for their money back for an order that was delivered and paid; for an order that has not shipped, cancel it instead, which refunds at once.",
    method: 'POST',
    path: '/refunds',
    parameters: [
      {
        name: 'order_id',
        type: 'string',
        description: 'The order number, e.g. ET-100123',
        required: true,
      },
      customer,
      { name: 'reason', type: 'string', description: 'Why, in a few words', required: false },
    ],
    customerArg: 'customer_email',
    tier: 'transactional',
    // Refunds are decided by the Payments team (ADR 0031).
    approverTeam: 'Payments',
  },
  {
    name: 'shop_status',
    title: 'Shop status',
    description:
      'Whether payments and the carrier are working right now, and how many orders are delayed. Use it when a customer says they cannot pay or that the shop is not working.',
    method: 'GET',
    path: '/shop-status',
    parameters: [],
    tier: 'read',
  },
  {
    name: 'product_lookup',
    title: 'Look up a product',
    description:
      'One product by its id: name, brand, price, colour, fabric, its rating out of 5 and whether it is in stock. Use the product_id from the ticket context when the customer asks about the product they have open, and an id from a search when they ask more about one of those.',
    method: 'GET',
    path: '/products/{product_id}',
    parameters: [
      {
        name: 'product_id',
        type: 'string',
        description: 'The product id, e.g. b18e1b5c-ee0',
        required: true,
      },
    ],
    tier: 'read',
  },
  {
    name: 'product_search',
    title: 'Search products',
    description:
      'Finds products by words from the name, brand or category (for example "kurta" or "saree"): five at a time, or as many as limit says, up to ten. Use it when a customer wants to see or browse items, and when they name a product but there is no product_id in the ticket context. When they ask for more, pass the ids already shown in exclude so nothing is repeated. Each product comes with its price and its rating out of 5. It returns cards, so the products can be shown with their pictures.',
    method: 'GET',
    path: '/products',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'A few words from the name, the brand or the category, e.g. "silk saree"',
        required: true,
      },
      {
        name: 'limit',
        type: 'integer',
        description:
          'How many to give, 1 to 10. Ask for a few more than the customer wants, so you can leave out ones that do not fit',
        required: false,
      },
      {
        name: 'exclude',
        type: 'string',
        description: 'Ids of products already shown in this conversation, separated by commas',
        required: false,
      },
      {
        name: 'sort',
        type: 'string',
        description:
          'How to order them: rating (best rated first), price_low or price_high. Leave out for the closest names first',
        required: false,
      },
    ],
    tier: 'read',
  },
  {
    name: 'view_cart',
    title: 'Cart',
    description:
      'What is in the customer\'s cart now: each item with its size, quantity and price, and the subtotal. Use it when they ask what is in their cart, and before a change they describe as "one more" or "one less", so you know the current quantity.',
    method: 'GET',
    path: '/cart',
    parameters: [customer],
    customerArg: 'customer_email',
    tier: 'read',
  },
  {
    // Nothing is charged by it: the customer pays on the shop's own checkout page.
    name: 'payment_link',
    title: 'Payment link',
    description:
      "Gives a link to the checkout page for what is in the customer's cart, with the amount to pay. Use it when the customer wants to pay, check out, or asks for a payment or cart link, and send them the link. The customer signs in to the shop and pays there; nothing is charged by this request.",
    method: 'GET',
    path: '/checkout-link',
    parameters: [customer],
    customerArg: 'customer_email',
    tier: 'read',
  },
  {
    // Quantity is a total, so a call that is repeated changes nothing. There is
    // no tool that checks out: the customer sees every change before ordering.
    name: 'update_cart',
    title: 'Change the cart',
    description:
      "Sets how many of one product, in one size, the customer's cart holds. Use it to add an item, change its quantity or remove it (quantity 0). quantity is the total the cart should hold, not how many more. Take product_id from product_search or product_lookup, never from memory. Ask the customer for the size if they have not said one. Use it only when the customer clearly asks for the change. It never places an order: the customer checks out themselves.",
    method: 'POST',
    path: '/cart/items',
    parameters: [
      {
        name: 'product_id',
        type: 'string',
        description: "The product's id, exactly as product_search or product_lookup returned it",
        required: true,
      },
      {
        name: 'size',
        type: 'string',
        description: 'One of: S, M, L, XL, XXL, Free size. Needed unless quantity is 0',
        required: false,
      },
      {
        name: 'quantity',
        type: 'integer',
        description: 'How many the cart should hold in total, 0 to 5. 0 removes the item',
        required: true,
      },
      customer,
    ],
    customerArg: 'customer_email',
    tier: 'write',
  },
];

/** Events the shop wants to hear about (its /api/support/webhook). */
export const webhookEvents = [
  'ticket.created',
  'ticket.updated',
  'ticket.status_changed',
  'ticket.assigned',
  'message.created',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'approval.requested',
  'approval.decided',
  'csat.submitted',
] as const;

/** Password of the invented staff accounts, for signing in to Orbit Desk during a demo. */
export const STAFF_PASSWORD = 'Garment-Dem0!';
