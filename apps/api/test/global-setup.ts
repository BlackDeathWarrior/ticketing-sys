import { createDb, runMigrations, seedDatabase } from '@tms/db';
import Redis from 'ioredis';
import { Client } from 'pg';
import { TEST_ADMIN, testDatabaseUrl, testRedisUrl } from './test-env';

/** Resets the test database and Redis db once per run, then migrates and seeds. */
export default async function setup() {
  const url = testDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.end();

  await runMigrations(url);
  const handle = createDb(url, { max: 1 });
  await seedDatabase(handle.db, { ...TEST_ADMIN, demoData: true });
  await handle.close();

  const redis = new Redis(testRedisUrl());
  await redis.flushdb();
  await redis.quit();
}
