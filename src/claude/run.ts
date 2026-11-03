import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { z } from "zod";
import { apiKeyPresent, config } from "../config";
import { db } from "../db";

// Calls the already-logged-in Claude Code CLI in headless mode. This never uses
// the Anthropic API or an API key: the CLI runs on the owner's subscription.

export type ClaudeErrorKind =
  | "api_key_present"
  | "not_installed"
  | "auth"
  | "rate_limited"
  | "timeout"
  | "cli_error"
  | "invalid_output";

export class ClaudeError extends Error {
  constructor(
    public kind: ClaudeErrorKind,
    message: string,
  ) {
    super(message);
  }
}

// An empty, private working directory so the CLI never picks up a CLAUDE.md
// or project settings from wherever the server happens to be running.
const WORK_DIR = path.join(os.tmpdir(), "mom-english-claude");

interface RawResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runCli(args: string[], input: string, timeoutMs: number, cwd = WORK_DIR): Promise<RawResult> {
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Set when the server itself was started from inside a Claude Code session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new ClaudeError("not_installed", `Claude CLI not found at "${config.claudeBin}"`));
      } else {
        reject(new ClaudeError("cli_error", err.message));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(input);
  });
}

function classifyError(message: string): ClaudeErrorKind {
  if (/rate.?limit|usage limit|limit reached|429|overloaded|too many requests/i.test(message)) return "rate_limited";
  if (/authenticat|log ?in|oauth|401|credential|unauthori[sz]ed/i.test(message)) return "auth";
  return "cli_error";
}

// Pulls the first JSON object out of a text reply, tolerating ```json fences.
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function logCall(purpose: string, startedAt: number, error?: ClaudeError): void {
  db.prepare(
    "INSERT INTO claude_calls (purpose, started_at, ms, ok, error_kind, error) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    purpose,
    new Date(startedAt).toISOString(),
    Date.now() - startedAt,
    error ? 0 : 1,
    error?.kind ?? null,
    error ? error.message.slice(0, 500) : null,
  );
}

async function invokeOnce(purpose: string, system: string, prompt: string, jsonSchema: object, timeoutMs: number, files: string[] = []) {
  // With files (e.g. a screenshot), give the CLI a private folder holding only
  // copies of them and allow just the Read tool, so it can look but not act.
  let cwd = WORK_DIR;
  if (files.length) {
    cwd = fs.mkdtempSync(path.join(WORK_DIR, "files-"));
    for (const f of files) fs.copyFileSync(f, path.join(cwd, path.basename(f)));
  }
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    config.claudeModel,
    "--tools",
    files.length ? "Read" : "",
    ...(files.length ? ["--allowedTools", "Read"] : []),
    "--strict-mcp-config",
    "--no-session-persistence",
    "--system-prompt",
    system,
    "--json-schema",
    JSON.stringify(jsonSchema),
  ];
  const startedAt = Date.now();
  try {
    const raw = await runCli(args, prompt, timeoutMs, cwd).finally(() => {
      if (cwd !== WORK_DIR) fs.rmSync(cwd, { recursive: true, force: true });
    });
    if (raw.timedOut) throw new ClaudeError("timeout", `Claude CLI timed out after ${timeoutMs / 1000}s`);

    let wrapper: { is_error?: boolean; result?: string; structured_output?: unknown };
    try {
      wrapper = JSON.parse(raw.stdout);
    } catch {
      const msg = (raw.stderr || raw.stdout || `exit ${raw.code}`).slice(0, 500);
      throw new ClaudeError(classifyError(msg), `Unreadable CLI output: ${msg}`);
    }
    if (wrapper.is_error || raw.code !== 0) {
      const msg = wrapper.result || raw.stderr || `exit ${raw.code}`;
      throw new ClaudeError(classifyError(msg), msg);
    }
    let data: unknown = wrapper.structured_output;
    if (data === undefined) {
      try {
        data = extractJson(wrapper.result ?? "");
      } catch {
        throw new ClaudeError("invalid_output", `Reply was not JSON: ${(wrapper.result ?? "").slice(0, 200)}`);
      }
    }
    logCall(purpose, startedAt);
    return data;
  } catch (err) {
    const error = err instanceof ClaudeError ? err : new ClaudeError("cli_error", String(err));
    logCall(purpose, startedAt, error);
    throw error;
  }
}

export interface ClaudeJsonRequest<T> {
  purpose: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  // Extra checks zod's JSON-schema export can't express (e.g. answer index in range).
  check?: (value: T) => string[];
  timeoutMs?: number;
  // Files Claude may read (looked up by file name in its working folder).
  files?: string[];
}

// Asks for JSON matching `schema`. If the reply doesn't validate, asks once more
// with the problems spelled out, then gives up so the caller can fall back.
export async function callClaudeJson<T>(req: ClaudeJsonRequest<T>): Promise<T> {
  if (apiKeyPresent) {
    throw new ClaudeError("api_key_present", "ANTHROPIC_API_KEY is set; refusing to call Claude (would bill the API).");
  }
  // The CLI's validator doesn't know the 2020-12 meta-schema, so emit draft-07
  // and drop the $schema marker.
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(req.schema, { target: "draft-7", unrepresentable: "any" });
  const timeoutMs = req.timeoutMs ?? 240_000;

  let prompt = req.prompt;
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const data = await invokeOnce(req.purpose, req.system, prompt, jsonSchema, timeoutMs, req.files);
    const parsed = req.schema.safeParse(data);
    if (parsed.success) {
      lastProblems = req.check ? req.check(parsed.data) : [];
      if (lastProblems.length === 0) return parsed.data;
    } else {
      lastProblems = parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`);
    }
    prompt =
      `${req.prompt}\n\nIMPORTANT: your previous reply was rejected because of these problems:\n` +
      lastProblems.map((p) => `- ${p}`).join("\n") +
      `\nReturn a complete, corrected JSON reply.`;
  }
  const error = new ClaudeError("invalid_output", `Invalid output after retry: ${lastProblems.join("; ").slice(0, 400)}`);
  logCall(req.purpose, Date.now(), error);
  throw error;
}

export interface ClaudeHealth {
  apiKeyPresent: boolean;
  installed: boolean;
  version?: string;
  lastOk?: string;
  lastError?: { at: string; kind: string; message: string };
  last24h: { ok: number; failed: number };
}

export async function claudeHealth(): Promise<ClaudeHealth> {
  let installed = false;
  let version: string | undefined;
  try {
    const raw = await runCli(["--version"], "", 15_000);
    installed = raw.code === 0;
    version = raw.stdout.trim() || undefined;
  } catch {
    installed = false;
  }
  const lastOk = db.prepare("SELECT started_at FROM claude_calls WHERE ok = 1 ORDER BY id DESC LIMIT 1").get() as
    | { started_at: string }
    | undefined;
  const lastErr = db
    .prepare("SELECT started_at, error_kind, error FROM claude_calls WHERE ok = 0 ORDER BY id DESC LIMIT 1")
    .get() as { started_at: string; error_kind: string; error: string } | undefined;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const counts = db
    .prepare("SELECT SUM(ok) AS ok, SUM(1 - ok) AS failed FROM claude_calls WHERE started_at >= ?")
    .get(since) as { ok: number | null; failed: number | null };
  return {
    apiKeyPresent,
    installed,
    version,
    lastOk: lastOk?.started_at,
    lastError: lastErr ? { at: lastErr.started_at, kind: lastErr.error_kind, message: lastErr.error } : undefined,
    last24h: { ok: counts.ok ?? 0, failed: counts.failed ?? 0 },
  };
}
