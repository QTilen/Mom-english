import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });

export const ROOT_DIR = path.join(__dirname, "..");

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3001),
  adminPin: process.env.ADMIN_PIN || "",
  claudeBin: process.env.CLAUDE_BIN || "claude",
  claudeModel: process.env.CLAUDE_MODEL || "sonnet",
  timezone: process.env.TZ || "Europe/Ljubljana",
  dbPath: process.env.DB_PATH || path.join(ROOT_DIR, "data", "english.db"),
  imagesDir: process.env.IMAGES_DIR || path.join(ROOT_DIR, "data", "images"),
  // Jobs are polled rather than pushed; a few seconds is plenty for background work.
  jobPollMs: Number(process.env.JOB_POLL_MS || 5000),
};

// The whole point of this app is to run on the Claude subscription via the CLI.
// A stray key in the environment would silently switch the CLI to API billing,
// so we refuse to call Claude at all while one is present.
export const apiKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY);
