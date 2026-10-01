import { loadEnv } from './config/env';
import { startTracing, stopTracing } from './telemetry/tracing';
import { createWorker } from './worker/bootstrap';

async function main() {
  startTracing('tms-worker', loadEnv().OTEL_EXPORTER_OTLP_ENDPOINT);
  const worker = await createWorker();
  const stop = async () => {
    await worker.close();
    await stopTracing();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
