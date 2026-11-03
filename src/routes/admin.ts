import crypto from "crypto";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { db, nowIso, setSetting } from "../db";
import { LEVELS, levelLabel, MAX_LEVEL, SKILL_LABELS_SL, SKILLS } from "../levels";
import { CATEGORY_LABELS_SL, type Category } from "../content/schema";
import { callClaudeJson, claudeHealth } from "../claude/run";
import { enqueue } from "../jobs/queue";
import { localDate } from "../util/dates";
import { getLevels } from "../engine/levels";
import { bestStreak, currentStreak, freezesLeft, habitSettings, setTargetManually, targetMinutes } from "../engine/habit";
import { wordsLearnedCount } from "../engine/memory";
import { resetPlacement } from "../engine/placement";
import { REWARD_MILESTONES, rewardPlan, rewardProgress, rewardsList, setRewardText, totalStars } from "../engine/rewards";
import { favoriteTopics, learnerInterests, learnerName } from "../content/encouragement";
import { TOPICS, TOPIC_LABELS_SL } from "../content/schema";
import { addImage, deleteImage, extensionFor, listImages } from "../content/images";

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
    levelNames: LEVELS,
    levels: SKILLS.map((s) => ({ skill: s, label_sl: SKILL_LABELS_SL[s], level: levels[s], levelLabel: levelLabel(levels[s]) })),
    levelHistory,
    streak: currentStreak(today),
    bestStreak: bestStreak(),
    freezesLeft: freezesLeft(today),
    wordsLearned: wordsLearnedCount(),
    settings: { targetMinutes: targetMinutes(), ...habitSettings(), learnerName: learnerName() },
    rewardPlan: rewardPlan(),
    interests: learnerInterests(),
    images: listImages(),
    topics: TOPICS.map((t) => ({ id: t, label_sl: TOPIC_LABELS_SL[t], favorite: favoriteTopics().includes(t) })),
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
      targetMinutes: z.number().int().min(5).max(90).optional(),
      capMinutes: z.number().int().min(5).max(90).optional(),
      freezesPerWeek: z.number().int().min(0).max(7).optional(),
      rewardTexts: z.record(z.string(), z.string().trim().min(1).max(200)).optional(),
      interests: z.string().trim().min(1).max(1500).optional(),
      favoriteTopics: z.array(z.enum(TOPICS)).max(6).optional(),
      learnerName: z.string().trim().min(1).max(40).optional(),
    })
    .parse(req.body);
  if (body.interests !== undefined) setSetting("interests", body.interests);
  if (body.favoriteTopics !== undefined) setSetting("favorite_topics", JSON.stringify(body.favoriteTopics));
  for (const [days, text] of Object.entries(body.rewardTexts ?? {})) {
    if (REWARD_MILESTONES.includes(Number(days))) setRewardText(Number(days), text);
  }
  if (body.learnerName !== undefined) setSetting("learner_name", body.learnerName);
  if (body.capMinutes !== undefined) setSetting("cap_minutes", body.capMinutes);
  if (body.freezesPerWeek !== undefined) setSetting("freezes_per_week", body.freezesPerWeek);
  if (body.targetMinutes !== undefined) setTargetManually(body.targetMinutes, localDate());
  else if (body.capMinutes !== undefined && targetMinutes() > body.capMinutes) setTargetManually(body.capMinutes, localDate());
  res.json({ ok: true, settings: { targetMinutes: targetMinutes(), ...habitSettings(), learnerName: learnerName() } });
});

// Screenshot upload: the raw image is the request body, ?source=Zalando.
adminRouter.post("/images", express.raw({ type: "image/*", limit: "15mb" }), (req, res) => {
  const ext = extensionFor(req.headers["content-type"] ?? "");
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Pošlji sliko (PNG, JPG ali WebP)." });
  const source = typeof req.query.source === "string" ? req.query.source.slice(0, 60) : null;
  res.json({ id: addImage(req.body, ext, source) });
});

adminRouter.get("/images", (_req, res) => {
  res.json(listImages());
});

adminRouter.post("/images/:id/delete", (req, res) => {
  deleteImage(Number(req.params.id));
  res.json({ ok: true });
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
  const { level } = z.object({ level: z.number().int().min(0).max(MAX_LEVEL) }).parse(req.body);
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
