/** Where the stack under test lives. Defaults match `pnpm docker:up`. */
export const env = {
  api: process.env.API_URL ?? 'http://localhost:3000',
  orbit: process.env.ORBIT_URL ?? 'http://localhost:8081',
  console: process.env.WEB_URL ?? 'http://localhost:8080',
  widgetDemo: process.env.WIDGET_URL ?? 'http://localhost:8080/widget/demo.html',
  mailpit: process.env.MAILPIT_URL ?? 'http://localhost:8025',
  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: Number(process.env.SMTP_PORT ?? 3025),
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
