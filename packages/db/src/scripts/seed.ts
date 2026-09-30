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
      demoData: process.env.NODE_ENV !== 'production',
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
