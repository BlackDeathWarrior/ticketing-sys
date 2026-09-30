import { createApp } from './bootstrap';
import type { Env } from './config/env';
import { ENV } from './infra/tokens';

async function main() {
  const app = await createApp();
  const env = app.get<Env>(ENV);
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
