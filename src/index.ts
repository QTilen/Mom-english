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

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: "invalid request" });
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "server error" });
});

registerJobs();
startWorker(config.jobPollMs);
startScheduler();

app.listen(config.port, config.host, () => {
  console.log(`Mom English running at http://${config.host}:${config.port}`);
});
