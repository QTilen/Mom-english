import path from "path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { apiKeyPresent, config, ROOT_DIR } from "./config";
import "./db";
import { loadSeeds } from "./content/store";
import { startWorker } from "./jobs/queue";
import { registerJobs } from "./jobs/handlers";
import { startScheduler } from "./jobs/scheduler";
import { learnerRouter } from "./routes/learner";
import { adminRouter } from "./routes/admin";

const seeded = loadSeeds();
console.log(`Loaded seeds: ${seeded.bank} bank exercises`);
if (apiKeyPresent) {
  console.error("ANTHROPIC_API_KEY is set: Claude calls are disabled so nothing gets billed to the API. Unset it.");
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use("/api/admin", adminRouter);
app.use("/api", learnerRouter);
app.use(express.static(path.join(ROOT_DIR, "public")));
app.use("/images", express.static(config.imagesDir, { maxAge: "7d" }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: "invalid request" });
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "server error" });
});

registerJobs();
startWorker(config.jobPollMs);
startScheduler();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Mom English running at http://${config.host}:${config.port}`);
});

// On the Pi the listening socket once vanished while the process kept
// running (after a network change), leaving the app silently unreachable.
// Probe our own address every minute; after 3 failures exit so systemd
// restarts us with a fresh socket.
const SELF_CHECK_MS = 60_000;
const MAX_FAILED_CHECKS = 3;
let failedChecks = 0;
setInterval(async () => {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  try {
    const res = await fetch(`http://${host}:${config.port}/healthz`, { signal: AbortSignal.timeout(5000) });
    failedChecks = res.ok && server.listening ? 0 : failedChecks + 1;
  } catch {
    failedChecks++;
  }
  if (failedChecks >= MAX_FAILED_CHECKS) {
    console.error(`Self-check failed ${failedChecks} times in a row; exiting so systemd restarts the app.`);
    process.exit(1);
  }
}, SELF_CHECK_MS).unref();
