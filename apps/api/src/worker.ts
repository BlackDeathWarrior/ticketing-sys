import { createWorker } from './worker/bootstrap';

async function main() {
  const worker = await createWorker();
  const stop = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
