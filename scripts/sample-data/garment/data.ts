/**
 * The support desk of Ethnic Threads: what `load-garment.ts` sets up in a
 * running TMS so the garment-web-scraper app can use it (ADR 0027).
 *
 * Ethnic Threads is a real app (a catalogue of Indian ethnic wear scraped
 * from Amazon, Flipkart and Myntra). The staff here are invented and use the
 * reserved `.example` domain; the knowledge base in ./kb says only what the
 * app really does.
 */

/** The integration's identifier: the widget, the keys and the webhook hang off it. */
export const INTEGRATION = { slug: 'ethnic-threads', name: 'Ethnic Threads' };

export const branding = {
  companyName: 'Ethnic Threads',
  supportName: 'Ethnic Threads Support',
  helpCenterNote:
    'Ethnic Threads shows Indian ethnic wear from Amazon, Flipkart and Myntra in one place. You buy from the store, not from us.',
  referenceLabel: 'Listing',
};

export const teams = [
  { name: 'Customer Care', description: 'Shopper questions, feedback and chat' },
  { name: 'Catalogue', description: 'Wrong prices, stock and broken listings' },
  { name: 'Site Reliability', description: 'The scraper, the catalogue and the site itself' },
];

export interface GarmentUser {
  key: string;
  name: string;
  email: string;
  roles: string[];
  teams: string[];
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
    teams: ['Catalogue'],
    online: true,
  },
  {
    key: 'dev',
    name: 'Dev Malhotra',
    email: 'dev.malhotra@ethnicthreads.example',
    roles: ['agent'],
    teams: ['Site Reliability'],
    online: true,
  },
  // Approves what the AI may not do by itself (starting a scrape).
  {
    key: 'farah',
    name: 'Farah Khan',
    email: 'farah.khan@ethnicthreads.example',
    roles: ['supervisor'],
    teams: ['Site Reliability', 'Customer Care'],
    online: false,
  },
];

/**
 * Top-level names are what the app sends as `category` with a ticket
 * (see `scraper/support/routes.py` in the garment repo), so they must match.
 */
export const categories: Array<{ name: string; children: string[] }> = [
  { name: 'Listings', children: ['Wrong price', 'Out of stock', 'Broken link', 'Wrong details'] },
  { name: 'Site problem', children: ['Search and filters', 'Sign-in', 'Page not loading'] },
  { name: 'Feedback', children: ['Feature suggestion', 'General feedback'] },
  { name: 'Store orders', children: ['Delivery', 'Returns and refunds'] },
];

/**
 * Urgent tickets are timed in minutes so a breach can be seen happening in a
 * demo: a shopper who writes "urgent" and asks for a person must be answered
 * within two minutes.
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
    name: 'Scraper incidents',
    conditions: { tag: 'incident' },
    team: 'Site Reliability',
    strategy: 'least_loaded',
  },
  {
    name: 'Listing problems',
    conditions: {},
    category: 'Listings',
    team: 'Catalogue',
    strategy: 'least_loaded',
  },
  {
    name: 'Site problems',
    conditions: {},
    category: 'Site problem',
    team: 'Site Reliability',
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
  files: [
    'about-ethnic-threads.md',
    'prices-and-availability.md',
    'reporting-a-listing.md',
    'using-the-site.md',
  ],
  /** For agents and the copilot only: never shown or said to a shopper. */
  internal: {
    title: 'Scraper incidents: what they mean and what to do',
    content: [
      '# Scraper incidents: what they mean and what to do',
      '',
      'Incident tickets are opened by the app itself. Repeats are counted on the same ticket; the ticket resolves by itself when the app reports a recovery and nobody has taken it.',
      '',
      '## Scraper run failed',
      'The scrape process exited with an error. The end of its output is in the ticket. Check the scraper log, fix the cause, and start a scrape from the admin controls. A successful run resolves the incident.',
      '',
      '## A store returned no products, or a store scrape failed',
      'The store changed its pages, blocked the scraper or timed out. One failed cycle is common; act when it repeats. Listings from that store go out of date while it lasts.',
      '',
      '## Amazon is showing a CAPTCHA',
      'Amazon has rate-limited the scraper. It skips the search and retries in later cycles. If it lasts for hours, stop the scraper for a while.',
      '',
      '## Catalogue upload to S3 failed',
      'The scrape itself worked; publishing the catalogue file failed. Check the AWS credentials of the machine that runs the scraper.',
      '',
      '## Catalogue is stale',
      'No scrape has refreshed the catalogue for two days. Prices on the site may no longer match the stores. Start a scrape.',
      '',
      '## Who may start a scrape',
      'The admin can start one from the site. The AI may only ask: a request to start a scrape waits under Approvals for a supervisor.',
    ].join('\n'),
  },
};

export interface GarmentTool {
  name: string;
  title: string;
  description: string;
  method: 'GET' | 'POST';
  /** Under the worker's /api/support/tools. */
  path: string;
  parameters: Array<{
    name: string;
    type: 'string' | 'integer';
    description: string;
    required: boolean;
  }>;
  tier: 'read' | 'transactional';
}

/**
 * Custom HTTP tools (ADR 0017) that call the garment app's worker. Reading is
 * free; starting a scrape is `transactional`, so it waits for a supervisor.
 */
export const tools: GarmentTool[] = [
  {
    name: 'catalog_status',
    title: 'Catalogue freshness',
    description:
      'How many listings the catalogue has, when it was last refreshed and whether it is stale. Use it when a shopper says prices or stock look old or wrong.',
    method: 'GET',
    path: '/catalog-status',
    parameters: [],
    tier: 'read',
  },
  {
    name: 'scraper_status',
    title: 'Scraper status',
    description:
      'Whether the scraper that refreshes the catalogue is running, when it last ran and whether that run failed. Use it when the catalogue is stale or a shopper asks why the site is not updating.',
    method: 'GET',
    path: '/scrape-status',
    parameters: [],
    tier: 'read',
  },
  {
    name: 'scraper_log_tail',
    title: 'Scraper log',
    description:
      'The last lines of the scraper log. Use it after scraper_status shows a failed run, to see what went wrong. Never paste the log to a shopper; say what it means.',
    method: 'GET',
    path: '/log-tail',
    parameters: [
      {
        name: 'lines',
        type: 'integer',
        description: 'How many lines, 1 to 100',
        required: false,
      },
    ],
    tier: 'read',
  },
  {
    name: 'product_lookup',
    title: 'Look up a listing',
    description:
      'One listing by its id: title, store, price, stock and when it was last scraped. Use the product_id from the ticket context when the shopper asks about the listing they have open.',
    method: 'GET',
    path: '/products/{product_id}',
    parameters: [
      {
        name: 'product_id',
        type: 'string',
        description: 'The listing id, e.g. b18e1b5c-ee0',
        required: true,
      },
    ],
    tier: 'read',
  },
  {
    name: 'product_search',
    title: 'Search listings',
    description:
      'Up to five listings whose title or brand contains the given words. Use it when a shopper names a product but there is no product_id in the ticket context.',
    method: 'GET',
    path: '/products',
    parameters: [
      {
        name: 'query',
        type: 'string',
        description: 'A few words from the title or the brand, e.g. "silk saree"',
        required: true,
      },
    ],
    tier: 'read',
  },
  {
    name: 'trigger_rescrape',
    title: 'Start a scrape',
    description:
      'Starts the scraper to refresh prices and stock from the stores. Needs a supervisor to approve it. Use it when the catalogue is stale and no scrape is running.',
    method: 'POST',
    path: '/rescrape',
    parameters: [
      {
        name: 'source',
        type: 'string',
        description: 'One store to refresh: amazon, flipkart or myntra. Leave out for all.',
        required: false,
      },
      {
        name: 'reason',
        type: 'string',
        description: 'Why, in a few words',
        required: false,
      },
    ],
    tier: 'transactional',
  },
];

/** Events the app's worker wants to hear about (its /api/support/webhook). */
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
