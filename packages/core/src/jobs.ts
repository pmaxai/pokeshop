import type { Db } from './db.ts';
import { isPgError, SQLSTATE } from './db.ts';

export type Job = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

/** Queues a job; with a dedupe key at most one such job is open at a time. Returns false if one already is. */
export async function enqueueJob(
  db: Db,
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {},
): Promise<boolean> {
  try {
    await db`
      INSERT INTO jobs (kind, payload, dedupe_key, run_after, max_attempts)
      VALUES (${kind}, ${db.json(payload as never)}, ${opts.dedupeKey ?? null},
              ${opts.runAfter ?? new Date()}, ${opts.maxAttempts ?? 5})`;
    return true;
  } catch (e) {
    if (isPgError(e, SQLSTATE.uniqueViolation)) return false;
    throw e;
  }
}

/** Takes the next due job; SKIP LOCKED lets several workers share the queue. */
export async function claimJob(db: Db): Promise<Job | null> {
  const [job] = await db<Job[]>`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_after <= now()
                  ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, kind, payload, attempts, max_attempts`;
  return job ?? null;
}

export async function finishJob(db: Db, id: number): Promise<void> {
  await db`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL WHERE id = ${id}`;
}

/** Retries with exponential backoff (1, 2, 4 … minutes) until max_attempts, then marks it failed. */
export async function failJob(db: Db, job: Job, error: string): Promise<void> {
  const final = job.attempts >= job.max_attempts;
  await db`
    UPDATE jobs SET status = ${final ? 'failed' : 'pending'}, locked_at = NULL,
                    last_error = ${error.slice(0, 2000)},
                    run_after = now() + make_interval(mins => ${2 ** (job.attempts - 1)}),
                    finished_at = ${final ? new Date() : null}
     WHERE id = ${job.id}`;
}

/** Jobs left "running" by a crashed worker go back into the queue. */
export async function requeueStaleJobs(db: Db, olderThanMinutes = 30): Promise<number> {
  const r = await db`
    UPDATE jobs SET status = 'pending', locked_at = NULL
     WHERE status = 'running' AND locked_at < now() - make_interval(mins => ${olderThanMinutes})`;
  return r.count;
}
