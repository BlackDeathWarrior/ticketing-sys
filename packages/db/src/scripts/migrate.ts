import { runMigrations } from '../migrate';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  await runMigrations(url);
  console.log('Migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
