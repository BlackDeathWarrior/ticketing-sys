import { createApp } from './bootstrap';
import { type Env, loadEnv } from './config/env';
import { ENV } from './infra/tokens';
import { startTracing } from './telemetry/tracing';

async function main() {
  startTracing('tms-api', loadEnv().OTEL_EXPORTER_OTLP_ENDPOINT);
  const app = await createApp();
  const env = app.get<Env>(ENV);
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
