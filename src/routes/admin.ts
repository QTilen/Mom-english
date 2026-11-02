import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { db, nowIso, setSetting } from "../db";
import { levelLabel, SKILL_LABELS_SL, SKILLS } from "../levels";
import { CATEGORY_LABELS_SL, type Category } from "../content/schema";
import { callClaudeJson, claudeHealth } from "../claude/run";
import { enqueue } from "../jobs/queue";
import { localDate } from "../util/dates";
import { getLevels } from "../engine/levels";
import { bestStreak, currentStreak, freezesLeft, habitSettings, setTargetManually, targetMinutes } from "../engine/habit";
import { wordsLearnedCount } from "../engine/memory";
import { resetPlacement } from "../engine/placement";
import { rewardProgress, rewardSettings, rewardsList, totalStars } from "../engine/rewards";
import { learnerName } from "../content/encouragement";

export const adminRouter = Router();

const COOKIE = "admin_token";
const TOKEN_DAYS = 30;
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60_000;
let failures = 0;
let lockedUntil = 0;

function tokenFrom(req: Request): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function pinMatches(pin: string): boolean {
  const a = crypto.createHash("sha256").update(pin).digest();
  const b = crypto.createHash("sha256").update(config.adminPin).digest();
  return crypto.timingSafeEqual(a, b);
}

adminRouter.post("/login", (req, res) => {
  if (!config.adminPin) return res.status(503).json({ error: "ADMIN_PIN ni nastavljen v .env" });
  if (Date.now() < lockedUntil) return res.status(429).json({ error: "Preveč poskusov. Poskusi čez nekaj minut." });
  const { pin } = z.object({ pin: z.string().max(64) }).parse(req.body);
  if (!pinMatches(pin)) {
    failures++;
    if (failures >= MAX_FAILURES) {
      lockedUntil = Date.now() + LOCK_MS;
      failures = 0;
    }
    return res.status(401).json({ error: "Napačen PIN." });
  }
  failures = 0;
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + TOKEN_DAYS * 86_400_000);
  db.prepare("DELETE FROM admin_tokens WHERE expires_at < ?").run(nowIso());
  db.prepare("INSERT INTO admin_tokens (token, expires_at) VALUES (?, ?)").run(token, expires.toISOString());
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${TOKEN_DAYS * 86400}`,
  );
  res.json({ ok: true });
});

adminRouter.use((req: Request, res: Response, next: NextFunction) => {
  const token = tokenFrom(req);
  const row = token ? db.prepare("SELECT expires_at FROM admin_tokens WHERE token = ?").get(token) as { expires_at: string } | undefined : undefined;
  if (!row || row.expires_at < nowIso()) return res.status(401).json({ error: "login required" });
  next();
});

adminRouter.post("/logout", (req, res) => {
  const token = tokenFrom(req);
  if (token) db.prepare("DELETE FROM admin_tokens WHERE token = ?").run(token);
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0`);
  res.json({ ok: true });
});

adminRouter.get("/overview", async (_req, res) => {
  const today = localDate();
  const levels = getLevels();
  const sessions = db
    .prepare(
      `SELECT s.id, s.status, s.generated_by, s.target_minutes, s.local_date, s.created_at, s.completed_at,
              (SELECT COUNT(*) FROM session_items si WHERE si.session_id = s.id) AS items,
              (SELECT SUM(a.correct) FROM attempts a JOIN session_items si ON si.id = a.session_item_id WHERE si.session_id = s.id) AS correct,
              (SELECT COUNT(a.correct) FROM attempts a JOIN session_items si ON si.id = a.session_item_id WHERE si.session_id = s.id) AS graded,
              (SELECT SUM(a.ms) FROM attempts a JOIN session_items si ON si.id = a.session_item_id WHERE si.session_id = s.id) AS ms
       FROM sessions s WHERE s.status != 'discarded' ORDER BY s.id DESC LIMIT 60`,
    )
    .all();
  const mistakeCounts = (
    db
      .prepare(
        `SELECT category, COUNT(*) AS total, SUM(created_at >= ?) AS recent FROM mistakes GROUP BY category ORDER BY recent DESC, total DESC`,
      )
      .all(new Date(Date.now() - 30 * 86_400_000).toISOString()) as { category: string; total: number; recent: number }[]
  ).map((m) => ({ ...m, label_sl: CATEGORY_LABELS_SL[m.category as Category] ?? m.category }));
  const recentMistakes = db.prepare("SELECT category, detail, created_at FROM mistakes ORDER BY id DESC LIMIT 40").all();
  const levelHistory = db.prepare("SELECT skill, from_level, to_level, reason, created_at FROM level_history ORDER BY id").all();
  const jobs = db.prepare("SELECT id, type, status, tries, run_after, last_error, created_at, finished_at FROM jobs ORDER BY id DESC LIMIT 25").all();
  const bank = db
    .prepare("SELECT level, skill, COUNT(*) AS n FROM exercises WHERE source IN ('seed','claude') GROUP BY level, skill")
    .all();
  const reviews = db
    .prepare("SELECT id, kind, status, text, result_json, created_at, graded_at FROM writing_reviews ORDER BY id DESC LIMIT 20")
    .all();
  const ready = db.prepare("SELECT id, generated_by, created_at FROM sessions WHERE status = 'ready' ORDER BY id DESC LIMIT 1").get();

  res.json({
    today,
    levels: SKILLS.map((s) => ({ skill: s, label_sl: SKILL_LABELS_SL[s], level: levels[s], levelLabel: levelLabel(levels[s]) })),
    levelHistory,
    streak: currentStreak(today),
    bestStreak: bestStreak(),
    freezesLeft: freezesLeft(today),
    wordsLearned: wordsLearnedCount(),
    settings: { targetMinutes: targetMinutes(), ...habitSettings(), ...rewardSettings(), learnerName: learnerName() },
    stars: totalStars(),
    reward: rewardProgress(currentStreak(today)),
    rewards: rewardsList(),
    sessions,
    readySession: ready ?? null,
    mistakeCounts,
    recentMistakes,
    jobs,
    bank,
    reviews,
    claude: await claudeHealth(),
  });
});

adminRouter.post("/settings", (req, res) => {
  const body = z
    .object({
      targetMinutes: z.number().int().min(5).max(60).optional(),
      capMinutes: z.number().int().min(5).max(60).optional(),
      stepMinutes: z.number().int().min(1).max(10).optional(),
      freezesPerWeek: z.number().int().min(0).max(7).optional(),
      rewardEveryDays: z.number().int().min(3).max(100).optional(),
      rewardText: z.string().trim().min(1).max(200).optional(),
      learnerName: z.string().trim().min(1).max(40).optional(),
    })
    .parse(req.body);
  if (body.rewardEveryDays !== undefined) setSetting("reward_every_days", body.rewardEveryDays);
  if (body.rewardText !== undefined) setSetting("reward_text", body.rewardText);
  if (body.learnerName !== undefined) setSetting("learner_name", body.learnerName);
  if (body.capMinutes !== undefined) setSetting("cap_minutes", body.capMinutes);
  if (body.stepMinutes !== undefined) setSetting("step_minutes", body.stepMinutes);
  if (body.freezesPerWeek !== undefined) setSetting("freezes_per_week", body.freezesPerWeek);
  if (body.targetMinutes !== undefined) setTargetManually(body.targetMinutes, localDate());
  else if (body.capMinutes !== undefined && targetMinutes() > body.capMinutes) setTargetManually(body.capMinutes, localDate());
  res.json({ ok: true, settings: { targetMinutes: targetMinutes(), ...habitSettings(), ...rewardSettings(), learnerName: learnerName() } });
});

// Tick off a reward once the family has actually given it.
adminRouter.post("/rewards/:id/given", (req, res) => {
  db.prepare("UPDATE rewards SET given_at = ? WHERE id = ? AND given_at IS NULL").run(nowIso(), Number(req.params.id));
  res.json({ ok: true });
});

adminRouter.post("/regenerate", (_req, res) => {
  res.json({ jobId: enqueue("generate_session", { reason: "manual" }) });
});

adminRouter.post("/refill", (req, res) => {
  const { level } = z.object({ level: z.number().int().min(0).max(5) }).parse(req.body);
  res.json({ jobId: enqueue("refill_bank", { level }) });
});

adminRouter.post("/retry-failed", (_req, res) => {
  const info = db.prepare("UPDATE jobs SET status = 'queued', tries = 0, run_after = ? WHERE status = 'failed'").run(nowIso());
  res.json({ requeued: info.changes });
});

adminRouter.post("/reset-placement", (_req, res) => {
  resetPlacement();
  res.json({ ok: true });
});

// A real (tiny) CLI round trip, to check the login works end to end.
adminRouter.post("/claude-test", async (_req, res) => {
  try {
    const out = await callClaudeJson({
      purpose: "health_check",
      system: "Reply with JSON only.",
      prompt: 'Return {"reply": "pong"}.',
      schema: z.object({ reply: z.string() }),
      timeoutMs: 120_000,
    });
    res.json({ ok: true, reply: out.reply });
  } catch (err) {
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
