/** Where the stack under test lives. Defaults match `pnpm docker:up`. */
export const env = {
  api: process.env.API_URL ?? 'http://localhost:3000',
  orbit: process.env.ORBIT_URL ?? 'http://localhost:8081',
  console: process.env.WEB_URL ?? 'http://localhost:8080',
  widgetDemo: process.env.WIDGET_URL ?? 'http://localhost:8080/widget/demo.html',
  /** The page that stands in for an integration's own site (apps/chat-widget/public/site.html). */
  widgetSite: process.env.WIDGET_SITE_URL ?? 'http://localhost:8080/widget/site.html',
  helpCenter: process.env.HELP_URL ?? 'http://localhost:8080/help/',
  mailpit: process.env.MAILPIT_URL ?? 'http://localhost:8025',
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: Number(process.env.SMTP_PORT ?? 3025),
  /** The stack's Redis: one spec queues a job that fails, to show it in Settings → System. */
  redis: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /**
   * How the API and worker reach a server started by a test on this machine
   * (a webhook receiver). From Docker that is `host.docker.internal`; for a
   * stack run on the host, set it to 127.0.0.1. The host must be listed in
   * the stack's WEBHOOK_PRIVATE_HOSTS.
   */
  hostFromStack: process.env.HOST_FROM_STACK ?? 'host.docker.internal',
};

export const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.ADMIN_PASSWORD ?? 'ChangeMe123!',
  name: 'Administrator',
};

/** Accounts created by `pnpm sample:load` (scripts/sample-data/data.ts). */
export const SAMPLE_PASSWORD = 'Sample-Passw0rd!';
export const AGENTS = {
  maya: { email: 'maya.lindqvist@tms.example', name: 'Maya Lindqvist' },
  jonah: { email: 'jonah.reyes@tms.example', name: 'Jonah Reyes' },
  leo: { email: 'leo.martin@tms.example', name: 'Leo Martin' },
  sam: { email: 'sam.okafor@tms.example', name: 'Sam Okafor' },
  priya: { email: 'priya.natarajan@tms.example', name: 'Priya Natarajan' },
};
