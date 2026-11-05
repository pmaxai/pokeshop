// Docker health check: the worker loop wrote its heartbeat within the last 2 minutes.
import { stat } from 'node:fs/promises';

const file = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/pokeshop-worker.heartbeat';
try {
  const age = Math.round((Date.now() - (await stat(file)).mtimeMs) / 1000);
  if (age >= 120) {
    console.error(`worker heartbeat is ${age} s old`);
    process.exit(1);
  }
} catch {
  console.error(`no worker heartbeat at ${file}`);
  process.exit(1);
}
