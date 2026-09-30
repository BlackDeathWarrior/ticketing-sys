import { createDb } from '../client';
import { seedDatabase } from '../seed';

async function main() {
  const url = process.env.DATABASE_URL;
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!url || !adminEmail || !adminPassword) {
    throw new Error('DATABASE_URL, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set');
  }
  const handle = createDb(url, { max: 1 });
  try {
    await seedDatabase(handle.db, {
      adminEmail,
      adminPassword,
      // Demo teams, categories and a customer: on outside production unless
      // SEED_DEMO_DATA says otherwise (the Docker demo stack sets it to true).
      demoData: process.env.SEED_DEMO_DATA
        ? process.env.SEED_DEMO_DATA === 'true'
        : process.env.NODE_ENV !== 'production',
    });
    console.log(`Seed complete. Admin: ${adminEmail}`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
