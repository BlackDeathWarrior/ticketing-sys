/**
 * Fictional sample data for demos and end-to-end tests. Every person, company
 * and address here is invented; email domains use the reserved example.* TLDs.
 */

export const SAMPLE_PASSWORD = 'Sample-Passw0rd!';

/** Its presence means the sample data is already loaded. */
export const MARKER_EMAIL = 'hana.ito@atlasfreight.example.com';

export interface SampleUser {
  key: string;
  name: string;
  email: string;
  roles: string[];
  teams: string[];
}

export const teams = [
  { name: 'Orders', description: 'Order status, delivery and cancellations' },
  { name: 'Billing', description: 'Payments, refunds and invoices' },
  { name: 'Returns', description: 'Returns and exchanges' },
  { name: 'Platform', description: 'Accounts, logins and integrations' },
];

export const users: SampleUser[] = [
  {
    key: 'maya',
    name: 'Maya Lindqvist',
    email: 'maya.lindqvist@tms.example',
    roles: ['team_lead'],
    teams: ['Orders'],
  },
  {
    key: 'jonah',
    name: 'Jonah Reyes',
    email: 'jonah.reyes@tms.example',
    roles: ['agent'],
    teams: ['Orders'],
  },
  {
    key: 'aiko',
    name: 'Aiko Tanaka',
    email: 'aiko.tanaka@tms.example',
    roles: ['agent'],
    teams: ['Billing'],
  },
  {
    key: 'nora',
    name: 'Nora Quist',
    email: 'nora.quist@tms.example',
    roles: ['agent'],
    teams: ['Billing'],
  },
  {
    key: 'sam',
    name: 'Sam Okafor',
    email: 'sam.okafor@tms.example',
    roles: ['agent'],
    teams: ['Returns'],
  },
  {
    key: 'leo',
    name: 'Leo Martin',
    email: 'leo.martin@tms.example',
    roles: ['agent'],
    teams: ['Platform'],
  },
  {
    key: 'priya',
    name: 'Priya Natarajan',
    email: 'priya.natarajan@tms.example',
    roles: ['supervisor'],
    teams: ['Platform'],
  },
];

export interface SampleCustomer {
  key: string;
  name: string;
  email: string;
  company: string;
  type: 'standard' | 'vip' | 'business' | 'internal';
  phone?: string;
  whatsapp?: string;
  language?: string;
}

export const customers: SampleCustomer[] = [
  {
    key: 'hana',
    name: 'Hana Ito',
    email: MARKER_EMAIL,
    company: 'Atlas Freight Co.',
    type: 'business',
    phone: '+81 90 5550 0142',
  },
  {
    key: 'marcus',
    name: 'Marcus Webb',
    email: 'marcus.webb@brightwater.example.org',
    company: 'Brightwater Dental',
    type: 'business',
  },
  {
    key: 'elena',
    name: 'Elena Rossi',
    email: 'elena.rossi@corvid.example.net',
    company: 'Corvid Analytics',
    type: 'vip',
    whatsapp: '+39 347 555 0198',
  },
  {
    key: 'tomas',
    name: 'Tomás Herrera',
    email: 'tomas@driftwood.example.com',
    company: 'Driftwood Outfitters',
    type: 'standard',
  },
  {
    key: 'ada',
    name: 'Ada Okonkwo',
    email: 'ada.okonkwo@emberoak.example.org',
    company: 'Ember & Oak Bakery',
    type: 'standard',
    whatsapp: '+234 803 555 0171',
  },
  {
    key: 'felix',
    name: 'Felix Braun',
    email: 'felix.braun@fernhill.example.com',
    company: 'Fernhill Clinics',
    type: 'business',
    language: 'de',
  },
  {
    key: 'grace',
    name: 'Grace Liu',
    email: 'grace.liu@granitepeak.example.net',
    company: 'Granite Peak Logistics',
    type: 'vip',
    phone: '+1 415 555 0133',
  },
  {
    key: 'henrik',
    name: 'Henrik Dahl',
    email: 'henrik@harborlane.example.org',
    company: 'Harbor Lane Books',
    type: 'standard',
  },
  {
    key: 'isla',
    name: 'Isla McKenna',
    email: 'isla.mckenna@ivoryloom.example.com',
    company: 'Ivory Loom Textiles',
    type: 'standard',
  },
  {
    key: 'jamal',
    name: 'Jamal Carter',
    email: 'jamal.carter@juniperhealth.example.net',
    company: 'Juniper Health',
    type: 'business',
    phone: '+1 312 555 0164',
  },
  {
    key: 'kiri',
    name: 'Kiri Tane',
    email: 'kiri.tane@kestrel.example.org',
    company: 'Kestrel Aviation Parts',
    type: 'business',
  },
  {
    key: 'lucia',
    name: 'Lucía Fernández',
    email: 'lucia@larkspur.example.com',
    company: 'Larkspur Studio',
    type: 'standard',
    language: 'es',
  },
  {
    key: 'mei',
    name: 'Mei Chen',
    email: 'mei.chen@meridiantutors.example.net',
    company: 'Meridian Tutors',
    type: 'standard',
  },
  {
    key: 'noah',
    name: 'Noah Fischer',
    email: 'noah.fischer@nimbusprint.example.org',
    company: 'Nimbus Print',
    type: 'standard',
  },
  {
    key: 'olivia',
    name: 'Olivia Grant',
    email: 'olivia.grant@orchardrow.example.com',
    company: 'Orchard Row Grocers',
    type: 'business',
    whatsapp: '+44 7700 900412',
  },
  {
    key: 'pavel',
    name: 'Pavel Novak',
    email: 'pavel.novak@pinecrest.example.net',
    company: 'Pinecrest Realty',
    type: 'standard',
  },
  {
    key: 'quinn',
    name: 'Quinn Adler',
    email: 'quinn.adler@quarrystone.example.org',
    company: 'Quarry Stone Works',
    type: 'standard',
  },
  {
    key: 'ravi',
    name: 'Ravi Menon',
    email: 'ravi.menon@riverbend.example.com',
    company: 'Riverbend Cycles',
    type: 'vip',
    phone: '+91 98450 55501',
  },
  {
    key: 'sofia',
    name: 'Sofia Laine',
    email: 'sofia.laine@saffrontable.example.net',
    company: 'Saffron Table',
    type: 'standard',
  },
  {
    key: 'theo',
    name: 'Theo Park',
    email: 'theo.park@tidewater.example.org',
    company: 'Tidewater Marine',
    type: 'business',
  },
  {
    key: 'uma',
    name: 'Uma Das',
    email: 'uma.das@umbercoffee.example.com',
    company: 'Umber Coffee Roasters',
    type: 'standard',
    whatsapp: '+91 99000 55523',
  },
  {
    key: 'victor',
    name: 'Victor Moreau',
    email: 'victor.moreau@valestreet.example.net',
    company: 'Vale Street Pharmacy',
    type: 'business',
    language: 'fr',
  },
  {
    key: 'wren',
    name: 'Wren Holloway',
    email: 'wren@willowfinch.example.org',
    company: 'Willow & Finch',
    type: 'standard',
  },
  {
    key: 'yara',
    name: 'Yara Haddad',
    email: 'yara.haddad@yarrowgarden.example.com',
    company: 'Yarrow Garden Supply',
    type: 'standard',
  },
  {
    key: 'zane',
    name: 'Zane Whitaker',
    email: 'zane@zephyrkites.example.net',
    company: 'Zephyr Kites',
    type: 'internal',
  },
];

/** Where a ticket ends up; the loader walks the workflow to get there. */
export type FinalStatus =
  | 'new'
  | 'ai_handling'
  | 'human_assigned'
  | 'in_progress'
  | 'pending_customer'
  | 'resolved'
  | 'closed';

export interface SampleTicket {
  customer: string;
  subject: string;
  description: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  channel: 'email' | 'agent' | 'voice' | 'whatsapp' | 'webchat';
  /** "Parent/Child" from the seeded category tree. */
  category?: string;
  team?: string;
  assignee?: string;
  status: FinalStatus;
  tags?: string[];
  notes?: Array<{ by: string; body: string }>;
  /** Agent reply by email (sent through the worker to Mailpit). */
  reply?: { by: string; body: string };
  resolution?: string;
  /** Backdating: hours since the ticket was opened. */
  ageHours: number;
  /** Backdating: hours from opening to resolution (resolved/closed tickets). */
  resolveAfterHours?: number;
}

export const tickets: SampleTicket[] = [
  // ---- urgent, open ----
  {
    customer: 'hana',
    subject: 'Shipment tracking page shows every container as "lost"',
    description:
      'Since this morning our tracking page marks all 38 containers in transit as lost. Our dispatch team cannot plan pickups.',
    priority: 'urgent',
    channel: 'email',
    category: 'Orders/Tracking',
    team: 'Orders',
    assignee: 'jonah',
    status: 'in_progress',
    tags: ['tracking', 'outage'],
    notes: [
      {
        by: 'maya',
        body: '@Jonah this matches the carrier feed delay reported by Platform. Please confirm with Leo.',
      },
      { by: 'jonah', body: 'Carrier feed is back; re-sync of Atlas containers is running.' },
    ],
    reply: {
      by: 'jonah',
      body: 'Hi Hana, we traced this to a delayed carrier feed. A re-sync is running now and statuses should be correct within the hour. I will confirm here once done.',
    },
    ageHours: 3,
  },
  {
    customer: 'grace',
    subject: 'Charged three times for order 55120',
    description:
      'Our corporate card shows three identical charges of 1,840.00 for order 55120. Please reverse the duplicates today, it blocks our month-end close.',
    priority: 'urgent',
    channel: 'voice',
    category: 'Billing/Duplicate charge',
    team: 'Billing',
    status: 'new',
    tags: ['refund', 'vip'],
    ageHours: 1,
  },
  {
    customer: 'jamal',
    subject: 'Nobody at Juniper Health can log in after password reset',
    description:
      'After the forced password reset last night, all 40 staff accounts get "invalid credentials". Clinic opens in two hours.',
    priority: 'urgent',
    channel: 'email',
    category: 'Account/Login',
    team: 'Platform',
    assignee: 'leo',
    status: 'human_assigned',
    tags: ['login', 'outage'],
    notes: [
      {
        by: 'priya',
        body: 'Escalated to Platform on-call. Keep the customer updated every 30 minutes.',
      },
    ],
    ageHours: 2,
  },
  {
    customer: 'theo',
    subject: 'Replacement engine parts delivered to the wrong harbour',
    description:
      'Parts for vessel repair went to Pier 4 instead of Pier 12. The boat cannot sail until they arrive.',
    priority: 'urgent',
    channel: 'whatsapp',
    category: 'Orders/Delivery issue',
    team: 'Orders',
    status: 'new',
    tags: ['delivery'],
    ageHours: 5,
  },
  // ---- high ----
  {
    customer: 'marcus',
    subject: 'Invoice 88213 billed at the old price list',
    description:
      'We moved to the annual plan on the 1st but invoice 88213 still uses monthly pricing.',
    priority: 'high',
    channel: 'email',
    category: 'Billing/Invoice',
    team: 'Billing',
    assignee: 'aiko',
    status: 'in_progress',
    tags: ['invoice'],
    reply: {
      by: 'aiko',
      body: 'Hi Marcus, you are right, the plan change was not applied to that invoice. I have asked finance to reissue it at the annual rate.',
    },
    ageHours: 20,
  },
  {
    customer: 'elena',
    subject: 'Webhook deliveries arriving 10+ minutes late',
    description:
      'Order events reach our endpoint 10 to 15 minutes after they happen. This started on Monday.',
    priority: 'high',
    channel: 'webchat',
    category: 'Account/Profile update',
    team: 'Platform',
    status: 'new',
    tags: ['webhooks'],
    ageHours: 7,
  },
  {
    customer: 'ravi',
    subject: 'Bulk order of 60 bikes stuck in "processing"',
    description:
      'Order 70411 for our spring stock has shown "processing" for four days. We need a ship date.',
    priority: 'high',
    channel: 'email',
    category: 'Orders/Tracking',
    team: 'Orders',
    assignee: 'maya',
    status: 'pending_customer',
    tags: ['bulk', 'vip'],
    reply: {
      by: 'maya',
      body: 'Hi Ravi, the order is waiting on a colour confirmation for 12 frames. Could you confirm whether "slate" is acceptable instead of "storm grey"?',
    },
    ageHours: 30,
  },
  {
    customer: 'felix',
    subject: 'Refund for returned X-ray sensors not received',
    description: 'We returned two sensors on the 12th with RMA 3321. The refund has not arrived.',
    priority: 'high',
    channel: 'email',
    category: 'Billing/Refund status',
    team: 'Billing',
    assignee: 'nora',
    status: 'human_assigned',
    tags: ['refund'],
    ageHours: 26,
  },
  {
    customer: 'olivia',
    subject: 'Cancel standing order before Friday dispatch',
    description:
      'Please cancel our weekly standing order 6620 before this Friday. We are switching suppliers for produce.',
    priority: 'high',
    channel: 'whatsapp',
    category: 'Orders/Cancellation',
    team: 'Orders',
    assignee: 'jonah',
    status: 'resolved',
    tags: ['cancellation'],
    resolution: 'Standing order 6620 cancelled; confirmation sent.',
    ageHours: 50,
    resolveAfterHours: 3,
  },
  {
    customer: 'kiri',
    subject: 'Certificate of conformity missing from shipment',
    description:
      'Shipment 9920 arrived without the certificates of conformity. We cannot install the parts without them.',
    priority: 'high',
    channel: 'email',
    category: 'Orders/Delivery issue',
    team: 'Orders',
    assignee: 'maya',
    status: 'closed',
    tags: ['documents'],
    resolution: 'Certificates emailed and originals posted.',
    ageHours: 150,
    resolveAfterHours: 9,
  },
  // ---- normal ----
  {
    customer: 'tomas',
    subject: 'Exchange hiking boots for a larger size',
    description: 'The boots from order 44102 are a size too small. Can I exchange them for a 44?',
    priority: 'normal',
    channel: 'email',
    category: 'Returns/Exchange',
    team: 'Returns',
    assignee: 'sam',
    status: 'in_progress',
    tags: ['exchange'],
    reply: {
      by: 'sam',
      body: 'Hi Tomás, happy to help. I have created exchange label EX-2231; drop the boots at any post office and we will ship the 44 as soon as they are scanned.',
    },
    ageHours: 18,
  },
  {
    customer: 'ada',
    subject: 'Change delivery day for flour orders',
    description: 'Could our weekly flour delivery move from Monday to Tuesday?',
    priority: 'normal',
    channel: 'whatsapp',
    category: 'Orders/Delivery issue',
    team: 'Orders',
    status: 'ai_handling',
    tags: ['schedule'],
    ageHours: 4,
  },
  {
    customer: 'henrik',
    subject: 'Order confirmation email never arrived',
    description: 'I placed order 51880 yesterday but did not get a confirmation email.',
    priority: 'normal',
    channel: 'email',
    category: 'Orders/Tracking',
    team: 'Orders',
    assignee: 'jonah',
    status: 'resolved',
    tags: ['email'],
    resolution: 'Confirmation resent; address had a typo, corrected on the account.',
    ageHours: 40,
    resolveAfterHours: 5,
  },
  {
    customer: 'isla',
    subject: 'Return a damaged roll of linen',
    description: 'One of the three linen rolls in order 47730 arrived with a tear along the edge.',
    priority: 'normal',
    channel: 'webchat',
    category: 'Returns/Return request',
    team: 'Returns',
    assignee: 'sam',
    status: 'pending_customer',
    tags: ['damaged'],
    notes: [{ by: 'sam', body: 'Asked for photos of the tear before issuing the label.' }],
    ageHours: 28,
  },
  {
    customer: 'lucia',
    subject: 'Update billing address on account',
    description:
      'We moved studios. Please update the billing address to Calle Ficticia 12, Valencia.',
    priority: 'normal',
    channel: 'email',
    category: 'Account/Profile update',
    team: 'Platform',
    assignee: 'leo',
    status: 'resolved',
    tags: ['account'],
    resolution: 'Billing address updated.',
    ageHours: 70,
    resolveAfterHours: 2,
  },
  {
    customer: 'mei',
    subject: 'Which plan includes group invoices?',
    description:
      'We run tutoring for several schools. Which plan lets us get one invoice per school?',
    priority: 'normal',
    channel: 'webchat',
    category: 'Billing/Invoice',
    team: 'Billing',
    status: 'new',
    tags: ['question'],
    ageHours: 9,
  },
  {
    customer: 'noah',
    subject: 'Printer ink cartridges back-ordered',
    description: 'Order 60235 says back-ordered. When will the cyan cartridges ship?',
    priority: 'normal',
    channel: 'email',
    category: 'Orders/Tracking',
    team: 'Orders',
    assignee: 'maya',
    status: 'resolved',
    tags: ['backorder'],
    resolution: 'Stock arrived; order shipped with tracking TRK-88311.',
    ageHours: 100,
    resolveAfterHours: 30,
  },
  {
    customer: 'pavel',
    subject: 'Receipt needed for tax purposes',
    description: 'Please send a VAT receipt for order 38812.',
    priority: 'normal',
    channel: 'email',
    category: 'Billing/Invoice',
    team: 'Billing',
    assignee: 'aiko',
    status: 'closed',
    tags: ['invoice'],
    resolution: 'VAT receipt emailed.',
    ageHours: 200,
    resolveAfterHours: 4,
  },
  {
    customer: 'quinn',
    subject: 'Wrong granite colour delivered',
    description: 'We ordered "Arctic White" slabs but received "Ash Grey" for order 29910.',
    priority: 'normal',
    channel: 'voice',
    category: 'Returns/Exchange',
    team: 'Returns',
    assignee: 'sam',
    status: 'in_progress',
    tags: ['wrong-item'],
    notes: [
      { by: 'sam', body: 'Warehouse confirms a picking error. Collection booked for Thursday.' },
    ],
    ageHours: 45,
  },
  {
    customer: 'sofia',
    subject: 'Allergen list for spice blends',
    description: 'Do your spice blends contain sesame? We need this for our menu.',
    priority: 'normal',
    channel: 'email',
    status: 'resolved',
    team: 'Orders',
    assignee: 'jonah',
    tags: ['question'],
    resolution: 'Sent the allergen sheet; blends 3 and 7 contain sesame.',
    ageHours: 120,
    resolveAfterHours: 6,
  },
  {
    customer: 'uma',
    subject: 'Subscription paused but still charged',
    description: 'I paused the coffee subscription on the 3rd, yet I was charged on the 10th.',
    priority: 'normal',
    channel: 'whatsapp',
    category: 'Billing/Refund status',
    team: 'Billing',
    assignee: 'nora',
    status: 'in_progress',
    tags: ['subscription', 'refund'],
    notes: [
      { by: 'nora', body: 'Pause was saved after the billing run started. Refund approved.' },
    ],
    ageHours: 22,
  },
  {
    customer: 'victor',
    subject: 'Portal times out when uploading prescriptions',
    description: 'Uploads over 5 MB fail with a timeout in the partner portal.',
    priority: 'normal',
    channel: 'email',
    category: 'Account/Profile update',
    team: 'Platform',
    assignee: 'leo',
    status: 'pending_customer',
    tags: ['portal'],
    reply: {
      by: 'leo',
      body: 'Bonjour Victor, could you tell us which browser you use and send a screenshot of the error? That helps us reproduce it.',
    },
    ageHours: 60,
  },
  {
    customer: 'wren',
    subject: 'Gift wrap missing from order',
    description: 'I paid for gift wrap on order 52001 but the items came unwrapped.',
    priority: 'normal',
    channel: 'webchat',
    category: 'Orders/Delivery issue',
    team: 'Orders',
    status: 'new',
    tags: ['gift'],
    ageHours: 12,
  },
  {
    customer: 'yara',
    subject: 'Return seed trays ordered twice',
    description:
      'I accidentally ordered the seed trays twice (orders 61002 and 61003). Can I return one set?',
    priority: 'normal',
    channel: 'email',
    category: 'Returns/Return request',
    team: 'Returns',
    assignee: 'sam',
    status: 'resolved',
    tags: ['return'],
    resolution: 'Order 61003 cancelled before dispatch; refund issued.',
    ageHours: 80,
    resolveAfterHours: 12,
  },
  {
    customer: 'marcus',
    subject: 'Add a second billing contact',
    description: 'Please add accounts@brightwater.example.org as a billing contact.',
    priority: 'normal',
    channel: 'email',
    category: 'Account/Profile update',
    team: 'Billing',
    assignee: 'aiko',
    status: 'resolved',
    tags: ['account'],
    resolution: 'Contact added.',
    ageHours: 170,
    resolveAfterHours: 1,
  },
  {
    customer: 'grace',
    subject: 'Quarterly volume discount not applied',
    description: 'Our Q3 volume passed 500 shipments but the discount is not on the invoice.',
    priority: 'normal',
    channel: 'email',
    category: 'Billing/Invoice',
    team: 'Billing',
    assignee: 'nora',
    status: 'resolved',
    tags: ['discount', 'vip'],
    resolution: 'Credit note CN-4410 issued for the discount.',
    ageHours: 260,
    resolveAfterHours: 20,
  },
  {
    customer: 'elena',
    subject: 'API key rotation schedule',
    description: 'How often should we rotate API keys, and can old keys overlap for a day?',
    priority: 'normal',
    channel: 'email',
    category: 'Account/Login',
    team: 'Platform',
    assignee: 'priya',
    status: 'closed',
    tags: ['security'],
    resolution: 'Shared the rotation guide; overlap of 24h is supported.',
    ageHours: 300,
    resolveAfterHours: 8,
  },
  {
    customer: 'hana',
    subject: 'Need customs paperwork template',
    description: 'Can you share the customs declaration template you use for EU shipments?',
    priority: 'normal',
    channel: 'email',
    category: 'Orders/Tracking',
    team: 'Orders',
    assignee: 'maya',
    status: 'resolved',
    tags: ['documents'],
    resolution: 'Template sent.',
    ageHours: 220,
    resolveAfterHours: 3,
  },
  {
    customer: 'ravi',
    subject: 'Dealer login shows wrong price tier',
    description: 'Our dealer account shows retail prices instead of dealer prices.',
    priority: 'normal',
    channel: 'webchat',
    category: 'Account/Login',
    team: 'Platform',
    assignee: 'leo',
    status: 'resolved',
    tags: ['pricing', 'vip'],
    resolution: 'Account moved to the dealer price tier.',
    ageHours: 30,
    resolveAfterHours: 2,
  },
  {
    customer: 'jamal',
    subject: 'Request audit log export',
    description:
      'For our compliance review we need an export of account access logs for September.',
    priority: 'normal',
    channel: 'email',
    category: 'Account/Profile update',
    team: 'Platform',
    status: 'new',
    tags: ['compliance'],
    ageHours: 15,
  },
  // ---- low ----
  {
    customer: 'zane',
    subject: 'Internal: test order for new kite catalogue',
    description:
      'Placing a test order to check the new catalogue images. Please ignore fulfilment.',
    priority: 'low',
    channel: 'agent',
    team: 'Orders',
    status: 'closed',
    tags: ['internal'],
    resolution: 'Test complete.',
    ageHours: 330,
    resolveAfterHours: 1,
  },
  {
    customer: 'henrik',
    subject: 'Suggestion: allow gift messages on e-books',
    description: 'It would be nice to add a gift message when buying e-books for someone.',
    priority: 'low',
    channel: 'email',
    status: 'new',
    tags: ['feedback'],
    ageHours: 90,
  },
  {
    customer: 'isla',
    subject: 'Newsletter unsubscribe not working',
    description: 'I clicked unsubscribe twice but still get the weekly newsletter.',
    priority: 'low',
    channel: 'email',
    category: 'Account/Profile update',
    team: 'Platform',
    assignee: 'leo',
    status: 'resolved',
    tags: ['email'],
    resolution: 'Removed from the list manually and fixed the link.',
    ageHours: 140,
    resolveAfterHours: 26,
  },
  {
    customer: 'mei',
    subject: 'Print-friendly version of invoices',
    description: 'The invoice PDF cuts off the last column when printed on A4.',
    priority: 'low',
    channel: 'webchat',
    category: 'Billing/Invoice',
    team: 'Billing',
    assignee: 'aiko',
    status: 'in_progress',
    tags: ['invoice'],
    ageHours: 75,
  },
  {
    customer: 'noah',
    subject: 'Update phone number on account',
    description: 'New phone number is +49 30 5550 1188.',
    priority: 'low',
    channel: 'voice',
    category: 'Account/Profile update',
    team: 'Platform',
    status: 'resolved',
    assignee: 'leo',
    tags: ['account'],
    resolution: 'Phone number updated.',
    ageHours: 190,
    resolveAfterHours: 1,
  },
  {
    customer: 'sofia',
    subject: 'Wholesale catalogue request',
    description: 'Could you send the wholesale catalogue for restaurants?',
    priority: 'low',
    channel: 'email',
    team: 'Orders',
    status: 'pending_customer',
    assignee: 'jonah',
    tags: ['catalogue'],
    reply: {
      by: 'jonah',
      body: 'Hi Sofia, the catalogue depends on your region. Could you confirm your delivery postcode?',
    },
    ageHours: 36,
  },
  {
    customer: 'tomas',
    subject: 'Feedback on packaging',
    description: 'Great packaging, but could you use less plastic filler?',
    priority: 'low',
    channel: 'webchat',
    status: 'closed',
    team: 'Returns',
    assignee: 'sam',
    tags: ['feedback'],
    resolution: 'Thanked customer; shared with the warehouse team.',
    ageHours: 280,
    resolveAfterHours: 48,
  },
  {
    customer: 'pavel',
    subject: 'Old order history missing',
    description: 'Orders before 2024 no longer show in my account history.',
    priority: 'low',
    channel: 'email',
    category: 'Account/Profile update',
    team: 'Platform',
    status: 'new',
    tags: ['account'],
    ageHours: 110,
  },
  {
    customer: 'victor',
    subject: 'French translation typo in checkout',
    description: 'Le bouton dit « Payez maintenent » — typo in "maintenant".',
    priority: 'low',
    channel: 'email',
    team: 'Platform',
    assignee: 'priya',
    status: 'resolved',
    tags: ['translation'],
    resolution: 'Typo fixed in the next release.',
    ageHours: 240,
    resolveAfterHours: 72,
  },
  {
    customer: 'kiri',
    subject: 'Request for bulk pricing sheet',
    description: 'Please send the 2027 bulk pricing sheet for fasteners.',
    priority: 'low',
    channel: 'email',
    team: 'Billing',
    assignee: 'nora',
    status: 'resolved',
    tags: ['pricing'],
    resolution: 'Pricing sheet sent.',
    ageHours: 10,
    resolveAfterHours: 4,
  },
];

/** Customers who write in through the widget; each becomes a web chat ticket. */
export const chats = [
  {
    name: 'Bea Sandoval',
    email: 'bea.sandoval@example.com',
    text: 'Hi! My discount code SPRING10 says it has expired but the email says it is valid until Sunday.',
  },
  {
    name: 'Omar Farouk',
    email: 'omar.farouk@example.org',
    text: 'Can I change the delivery address on order 73310? It has not shipped yet.',
  },
  {
    name: 'Lena Vogt',
    email: 'lena.vogt@example.net',
    text: 'The size guide for the rain jackets does not load on my phone.',
  },
  // The AI agent answers these from the knowledge base (or hands over).
  {
    name: 'Tom Whitaker',
    email: 'tom.whitaker@example.com',
    text: 'When will my refund reach my card? I returned the helmet last week.',
  },
  {
    name: 'Aarav Kulkarni',
    email: 'aarav.kulkarni@example.in',
    text: 'मेरा रिफंड कब तक आएगा? मैंने पिछले हफ्ते सामान लौटाया था।',
  },
  {
    name: 'Nina Petrova',
    email: 'nina.petrova@example.org',
    text: 'I would like to talk to a real person about my damaged cargo bike, please.',
  },
  // Answered from the Demo Store order system (Phase 6 tools). Tools act only for a visitor
  // the site vouches for, never for a typed email (ADR 0028), so these two are signed in.
  {
    name: 'María López',
    email: 'maria.lopez@example.com',
    text: 'Hi, where is my order DS-20517?',
    signedIn: true,
  },
  // Asks for a refund: waits in Approvals for a supervisor.
  {
    name: 'Kenji Watanabe',
    email: 'kenji.watanabe@example.org',
    text: 'I was charged twice for order DS-20533. Can you refund the extra charge?',
    signedIn: true,
  },
];

/**
 * Chats the AI answers and the customer never comes back to. The loader moves
 * them back in time, lets the AI resolve them (quiet for more than 72 hours),
 * and then answers the "How did we do?" question as the visitor would.
 */
export const quietChats: Array<{
  name: string;
  quietHours: number;
  rating: number;
  comment?: string;
}> = [
  { name: 'Tom Whitaker', quietHours: 96, rating: 5 },
  // A low rating of the AI's own answer: it shows up under Learning → To review.
  {
    name: 'Aarav Kulkarni',
    quietHours: 110,
    rating: 2,
    comment: 'I asked about a gift card refund, not a card refund.',
  },
  { name: 'María López', quietHours: 80, rating: 5 },
];

/**
 * A chat the AI passed to a person, who solved it. The visitor rates it 5:
 * under Learning it is offered as knowledge the AI could have had.
 */
export const answeredByPerson = {
  name: 'Bea Sandoval',
  agent: 'jonah',
  rating: 5,
  comment: 'Jonah fixed it straight away.',
};

/** Lessons staff wrote for the AI after reading ratings (ADR 0020). */
export const lessons = [
  {
    by: 'priya',
    body: 'When customers ask how long gift card refunds take, tell them: Gift card refunds go back to the gift card within 2 business days.',
  },
];

/**
 * Ratings customers give in the portal ("My requests") for resolved tickets.
 * The loader signs each customer in with the link emailed to them.
 */
export const ratings: Array<{
  customer: string;
  subject: string;
  rating: number;
  comment?: string;
}> = [
  {
    customer: 'henrik',
    subject: 'Order confirmation email never arrived',
    rating: 5,
    comment: 'Sorted within the hour, thank you.',
  },
  { customer: 'lucia', subject: 'Update billing address on account', rating: 4 },
  {
    customer: 'noah',
    subject: 'Printer ink cartridges back-ordered',
    rating: 2,
    comment: 'It took three days to hear back.',
  },
  { customer: 'noah', subject: 'Update phone number on account', rating: 5 },
  {
    customer: 'sofia',
    subject: 'Allergen list for spice blends',
    rating: 5,
    comment: 'Exactly what I needed.',
  },
  { customer: 'yara', subject: 'Return seed trays ordered twice', rating: 3 },
  { customer: 'grace', subject: 'Quarterly volume discount not applied', rating: 4 },
  { customer: 'kiri', subject: 'Request for bulk pricing sheet', rating: 5 },
  {
    customer: 'ravi',
    subject: 'Dealer login shows wrong price tier',
    rating: 1,
    comment: 'I still see the wrong tier on some products.',
  },
];

/** Customer emails sent to the support mailbox; the worker turns each into a ticket. */
export const emails = [
  {
    fromName: 'Chidi Eze',
    from: 'chidi.eze@example.com',
    subject: 'Order 80114 arrived with a cracked screen',
    text: 'Hello, the tablet in order 80114 arrived with a cracked screen. I have photos. What are my options?',
  },
  {
    fromName: 'Freya Holm',
    from: 'freya.holm@example.org',
    subject: 'Invoice address for company purchase',
    text: 'Hi, we need invoices addressed to Holm Design ApS instead of my name. Can you update this?',
  },
  {
    fromName: 'Diego Paredes',
    from: 'diego.paredes@example.net',
    subject: 'Where is my refund?',
    text: 'I returned order 77421 two weeks ago and I have not received the refund yet.',
  },
];

/**
 * Requests from the help center's public form (channel `web_form`). Fixed
 * submission ids make a second load return the same tickets, not new ones.
 */
export const webForms = [
  {
    submissionId: '6f1d2a4e-8c3b-4f0a-9e21-5b7c9d0e1a01',
    name: 'Lena Fischer',
    email: 'lena.fischer@example.org',
    topic: 'Returns',
    orderNumber: 'DS-48213',
    subject: 'Wrong jacket size delivered',
    description:
      'I ordered the rain jacket in medium and received a small. Can I exchange it for the right size?',
  },
  {
    submissionId: '6f1d2a4e-8c3b-4f0a-9e21-5b7c9d0e1a02',
    name: 'Tomás Ribeiro',
    email: 'tomas.ribeiro@example.net',
    topic: 'Account',
    subject: 'Cannot change my delivery address',
    description:
      'When I save a new delivery address in my account the page reloads and the old address is still there.',
  },
];

/**
 * SLA, routing, skills and presence (Phase 7, ADR 0014). Support hours are
 * Monday to Saturday, 08:00–20:00 India time; urgent and high tickets are
 * timed around the clock. The loader backdates timers with their tickets, so
 * older open tickets show as at risk or breached.
 */
export const operations = {
  hours: {
    name: 'Support hours (India)',
    timezone: 'Asia/Kolkata',
    schedule: [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '08:00', end: '20:00' })),
    holidays: [
      { date: '2026-10-02', name: 'Gandhi Jayanti' },
      { date: '2026-10-20', name: 'Diwali' },
    ],
  },
  policies: [
    { name: 'Urgent', priority: 'urgent', firstResponseMinutes: 30, resolutionMinutes: 240 },
    { name: 'High', priority: 'high', firstResponseMinutes: 60, resolutionMinutes: 480 },
    {
      name: 'VIP',
      customerType: 'vip',
      firstResponseMinutes: 120,
      resolutionMinutes: 1440,
      supportHours: true,
    },
    { name: 'Standard', firstResponseMinutes: 240, resolutionMinutes: 2880, supportHours: true },
  ],
  /** First match wins. `team` is a team name; conditions use channel, priority, language. */
  rules: [
    {
      name: 'Hindi conversations',
      conditions: { language: 'hi' },
      team: 'Orders',
      strategy: 'least_loaded',
      requiredSkill: 'hindi',
    },
    {
      name: 'Urgent tickets',
      conditions: { priority: 'urgent' },
      team: 'Orders',
      strategy: 'least_loaded',
    },
    {
      name: 'Web chat',
      conditions: { channel: 'webchat' },
      team: 'Orders',
      strategy: 'round_robin',
    },
    {
      name: 'Email and web forms',
      conditions: { channel: 'email' },
      team: 'Returns',
      strategy: 'least_loaded',
    },
    {
      name: 'Help-center requests',
      conditions: { channel: 'web_form' },
      team: 'Returns',
      strategy: 'least_loaded',
    },
  ],
  skills: { jonah: ['hindi', 'orders'], aiko: ['billing'], nora: ['billing'], sam: ['returns'] },
  presence: {
    jonah: { status: 'online', capacity: 6 },
    maya: { status: 'online', capacity: 4 },
    aiko: { status: 'online', capacity: 5 },
    sam: { status: 'online', capacity: 5 },
    nora: { status: 'away', capacity: 5 },
    leo: { status: 'offline', capacity: 5 },
  } as Record<string, { status: 'online' | 'away' | 'offline'; capacity: number }>,
};

/**
 * "Demo Store systems": the sample MCP server in apps/fake-providers with
 * fictional orders and payments (ADR 0013). The token is a public
 * placeholder the fake server checks, not a credential. The URL is how the
 * API container reaches it.
 */
export const tools = {
  server: { name: 'Demo Store systems', authHeader: 'Authorization' },
  token: 'demo-store-token',
  /** Tools the AI may use; issue_refund keeps its "needs approval" tier. */
  enable: ['lookup_customer', 'order_status', 'payment_status', 'issue_refund'],
  /** A custom (HTTP) tool, next to the MCP ones: a plain request to the sample server. */
  custom: {
    name: 'systems_status',
    title: 'Store systems status',
    description:
      'Whether the Demo Store order and payment systems are up. Use it when a customer says the shop or checkout is not working.',
    method: 'GET',
    path: '/health',
    parameters: [],
    tier: 'read',
    enabled: true,
  },
};

/**
 * The scripted demo LLM (apps/fake-providers), so the AI features work with
 * no real keys. The "key" is a placeholder: the fake provider ignores it.
 * LiteLLM reaches the fake at FAKE_LLM_URL (a compose hostname).
 */
export const llm = {
  provider: {
    provider: 'openai_compatible',
    label: 'Demo model (scripted)',
    apiKey: 'not-a-real-key-scripted-demo',
    budgetUsd: 5,
    budgetPeriod: 'month',
  },
  models: [
    {
      model: 'scripted-cheap',
      label: 'Scripted (fast)',
      inputCostPerMTok: 0.1,
      outputCostPerMTok: 0.4,
      supportsTools: true,
      supportsJson: true,
    },
    {
      model: 'scripted-premium',
      label: 'Scripted (premium)',
      inputCostPerMTok: 3,
      outputCostPerMTok: 15,
      supportsTools: true,
      supportsJson: true,
    },
    {
      model: 'scripted-embed',
      label: 'Scripted embeddings',
      mode: 'embedding',
      inputCostPerMTok: 0.02,
      outputCostPerMTok: 0,
    },
  ],
  /** A few calls so the Usage tab has something to show. */
  warmUpCalls: 3,
} as const;

/**
 * Knowledge base: files in ./kb (fictional Demo Store policies), uploaded and
 * approved by the loader. `faqs` come from kb/faq-hi.json; `internal` stays
 * agent-only; `draft` is left unapproved to show the review step.
 */
export const kb = {
  files: [
    { file: 'returns-policy.md', contentType: 'text/markdown', visibility: 'public' },
    { file: 'shipping-faq.md', contentType: 'text/markdown', visibility: 'public' },
    { file: 'billing-faq.md', contentType: 'text/markdown', visibility: 'public' },
    { file: 'account-help.html', contentType: 'text/html', visibility: 'public' },
  ],
  faqFile: 'faq-hi.json',
  internal: {
    title: 'Escalation playbook',
    content: [
      '# Escalation playbook',
      '',
      '## Refunds above 10,000 rupees',
      'Refunds above 10,000 rupees need a supervisor to approve them. Add an internal note with the order number and the reason, then assign the ticket to the Billing team.',
      '',
      '## Angry or VIP customers',
      'VIP customers get a call back within 2 hours. Never promise a delivery date the courier has not confirmed.',
    ].join('\n'),
  },
  draft: {
    title: 'Monsoon delivery delays (draft)',
    content:
      'During heavy rain, deliveries in coastal cities may take 2 extra days. Not yet approved.',
  },
} as const;
