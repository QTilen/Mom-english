import { db, nowIso } from "../db";
import { ClaudeError } from "../claude/run";

// A tiny durable job queue in SQLite. One job runs at a time: Claude CLI calls
// are slow and share one subscription, so there is nothing to gain from parallelism.

export type JobHandler = (payload: any) => Promise<void>;

interface JobRow {
  id: number;
  type: string;
  payload_json: string;
  tries: number;
}

const handlers = new Map<string, JobHandler>();
let running = false;

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

// Skips the insert when an identical job is already waiting, so repeated
// triggers (a double click, the safety check) don't pile up duplicate work.
export function enqueue(type: string, payload: object = {}, runAfter: Date = new Date()): number | undefined {
  const payloadJson = JSON.stringify(payload);
  const existing = db
    .prepare("SELECT id FROM jobs WHERE type = ? AND payload_json = ? AND status IN ('queued', 'running')")
    .get(type, payloadJson) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare(
      "INSERT INTO jobs (type, payload_json, status, run_after, created_at) VALUES (?, ?, 'queued', ?, ?)",
    )
    .run(type, payloadJson, runAfter.toISOString(), nowIso());
  return Number(info.lastInsertRowid);
}

function retryDelayMs(err: unknown, tries: number): number | null {
  const minutes = 60_000;
  if (err instanceof ClaudeError) {
    switch (err.kind) {
      case "rate_limited":
        // Subscription limits reset over hours; back off up to 6h.
        return tries < 6 ? Math.min(360, 30 * 2 ** (tries - 1)) * minutes : null;
      case "invalid_output":
        return tries < 3 ? 5 * minutes : null;
      case "api_key_present":
        return null;
      default:
        // not installed / logged out / timeouts: keep trying gently so things
        // recover by themselves once the CLI is fixed.
        return tries < 6 ? Math.min(240, 10 * 2 ** (tries - 1)) * minutes : null;
    }
  }
  return tries < 3 ? 2 * minutes : null;
}

export async function runNextJob(): Promise<boolean> {
  if (running) return false;
  const job = db
    .prepare("SELECT id, type, payload_json, tries FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id LIMIT 1")
    .get(nowIso()) as JobRow | undefined;
  if (!job) return false;

  running = true;
  const tries = job.tries + 1;
  db.prepare("UPDATE jobs SET status = 'running', tries = ? WHERE id = ?").run(tries, job.id);
  try {
    const handler = handlers.get(job.type);
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(JSON.parse(job.payload_json));
    db.prepare("UPDATE jobs SET status = 'done', finished_at = ?, last_error = NULL WHERE id = ?").run(nowIso(), job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const delay = retryDelayMs(err, tries);
    if (delay !== null) {
      db.prepare("UPDATE jobs SET status = 'queued', run_after = ?, last_error = ? WHERE id = ?").run(
        new Date(Date.now() + delay).toISOString(),
        message.slice(0, 500),
        job.id,
      );
    } else {
      db.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, last_error = ? WHERE id = ?").run(
        nowIso(),
        message.slice(0, 500),
        job.id,
      );
    }
    console.error(`[jobs] ${job.type}#${job.id} try ${tries} failed: ${message}`);
  } finally {
    running = false;
  }
  return true;
}

export function startWorker(pollMs: number): void {
  // Anything marked running when we start was interrupted by a restart.
  db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run();
  setInterval(() => {
    void runNextJob();
  }, pollMs);
}
