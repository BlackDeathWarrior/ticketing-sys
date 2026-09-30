export const TEST_ADMIN = { adminEmail: 'admin@test.local', adminPassword: 'Admin-Passw0rd!' };

export const testDatabaseUrl = () =>
  process.env.TEST_DATABASE_URL ?? 'postgres://tms:tms@localhost:5432/tms_test';

export const testRedisUrl = () => process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';

/** Environment for the app under test; applied before the app module is imported. */
export function applyTestEnv() {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    JWT_SECRET: 'test-secret-that-is-definitely-long-enough-123',
    LITELLM_URL: 'http://127.0.0.1:9',
    CORS_ORIGINS: 'http://localhost:5173',
    OUTBOX_POLL_MS: '200',
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    S3_ACCESS_KEY: 'tms',
    S3_SECRET_KEY: 'tms-dev-secret',
    S3_BUCKET: 'tms-test',
    EMAIL_ENABLED: 'false',
  });
}

/** GreenMail (infra/docker-compose.yml) as both the support mailbox and the outgoing SMTP server. */
export const TEST_MAIL = {
  host: process.env.TEST_MAIL_HOST ?? 'localhost',
  smtpPort: Number(process.env.TEST_SMTP_PORT ?? 3025),
  imapPort: Number(process.env.TEST_IMAP_PORT ?? 3143),
  support: 'support@tms.local',
};

export function applyEmailEnv() {
  Object.assign(process.env, {
    EMAIL_ENABLED: 'true',
    EMAIL_ADDRESS: TEST_MAIL.support,
    EMAIL_FROM_NAME: 'TMS Support',
    EMAIL_IMAP_HOST: TEST_MAIL.host,
    EMAIL_IMAP_PORT: String(TEST_MAIL.imapPort),
    EMAIL_IMAP_SECURE: 'false',
    EMAIL_IMAP_USER: TEST_MAIL.support,
    EMAIL_IMAP_PASSWORD: 'support',
    EMAIL_POLL_SECONDS: '5',
    EMAIL_SMTP_HOST: TEST_MAIL.host,
    EMAIL_SMTP_PORT: String(TEST_MAIL.smtpPort),
    EMAIL_SMTP_SECURE: 'false',
  });
}
