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
  });
}
