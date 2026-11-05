// Docker health check: the worker loop wrote its heartbeat within the last 2 minutes.
import { stat } from 'node:fs/promises';

const file = process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/pokeshop-worker.heartbeat';
try {
  const s = await stat(file);
  process.exit(Date.now() - s.mtimeMs < 120_000 ? 0 : 1);
} catch {
  process.exit(1);
}
