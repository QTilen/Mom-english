import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { levelLabel, SKILL_LABELS_SL, SKILLS } from "../levels";
import { localDate, addDays } from "../util/dates";
import { answerPlacement, placementQuestion, placementResult, startPlacement } from "../engine/placement";
import { answerItem, completeSession, markFeedbackSeen, todayState } from "../engine/session";
import { getLevels } from "../engine/levels";
import { bestStreak, currentStreak, freezesLeft, settleDays, targetMinutes } from "../engine/habit";
import { wordsLearnedCount } from "../engine/memory";
import { badgeStates, practiceDays, rewardProgress, rewardsList, totalStars } from "../engine/rewards";
import { learnerName } from "../content/encouragement";

export const learnerRouter = Router();

const AnswerSchema = z.union([
  z.object({ option: z.string().max(300) }),
  z.object({ text: z.string().max(4000) }),
  z.object({ words: z.array(z.string().max(60)).max(30) }),
  z.object({ matches: z.array(z.string().max(80)).max(10) }),
  z.object({ options: z.array(z.string().max(300)).max(5) }),
]);
const Ms = z.number().int().min(0).max(3_600_000).nullable().optional();

learnerRouter.get("/today", (_req, res) => {
  res.json(todayState());
});

learnerRouter.post("/recap/seen", (req, res) => {
  const body = z.object({ ids: z.array(z.number().int()).max(50) }).parse(req.body);
  markFeedbackSeen(body.ids);
  res.json({ ok: true });
});

learnerRouter.get("/placement", (_req, res) => {
  const result = placementResult();
  if (result && db.prepare("SELECT value FROM settings WHERE key = 'placement_done' AND value = '1'").get()) {
    return res.json({ done: true, name: learnerName(), result: withLabels(result) });
  }
  res.json({ ...placementQuestion(startPlacement()), name: learnerName() });
});

learnerRouter.post("/placement/answer", (req, res) => {
  const body = z
    .object({
      attemptId: z.number().int(),
      key: z.string().max(20),
      answer: z.union([z.object({ skip: z.literal(true) }), AnswerSchema]),
      ms: Ms,
    })
    .parse(req.body);
  const next = answerPlacement(body.attemptId, body.key, body.answer as never, body.ms ?? null);
  if (next.done) {
    const result = placementResult();
    return res.json({ ...next, name: learnerName(), result: result ? withLabels(result) : undefined });
  }
  res.json(next);
});

learnerRouter.get("/placement/result", (_req, res) => {
  const result = placementResult();
  res.json(result ? withLabels(result) : null);
});

function withLabels(result: { levels: Record<string, number>; writingPending: boolean }) {
  return {
    writingPending: result.writingPending,
    skills: SKILLS.map((s) => ({ skill: s, label_sl: SKILL_LABELS_SL[s], level: result.levels[s], levelLabel: levelLabel(result.levels[s]) })),
  };
}

learnerRouter.post("/session/:id/answer", (req, res) => {
  const body = z.object({ itemId: z.number().int(), answer: AnswerSchema, ms: Ms }).parse(req.body);
  res.json(answerItem(Number(req.params.id), body.itemId, body.answer, body.ms ?? null));
});

learnerRouter.post("/session/:id/complete", (req, res) => {
  res.json(completeSession(Number(req.params.id)));
});

learnerRouter.get("/progress", (_req, res) => {
  const today = localDate();
  settleDays(today);
  const levels = getLevels();
  const days = db.prepare("SELECT date, status FROM days WHERE date >= ?").all(addDays(today, -13)) as { date: string; status: string }[];
  const byDate = new Map(days.map((d) => [d.date, d.status]));
  const totals = db
    .prepare("SELECT COUNT(*) AS sessions FROM sessions WHERE status = 'completed'")
    .get() as { sessions: number };
  const minutes = db.prepare("SELECT COALESCE(SUM(ms), 0) AS ms FROM attempts").get() as { ms: number };
  const recentWords = db
    .prepare("SELECT en, sl FROM words WHERE correct_days >= 2 AND last_result = 1 ORDER BY last_correct_date DESC LIMIT 12")
    .all();
  const streak = currentStreak(today);
  const stars = totalStars();
  const wordsLearned = wordsLearnedCount();
  res.json({
    name: learnerName(),
    skills: SKILLS.map((s) => ({ skill: s, label_sl: SKILL_LABELS_SL[s], level: levels[s], levelLabel: levelLabel(levels[s]) })),
    streak,
    bestStreak: bestStreak(),
    stars,
    fires: practiceDays(),
    reward: rewardProgress(streak),
    rewards: rewardsList().map((r) => ({ unlocked_on: r.unlocked_on, reward_text: r.reward_text, given: Boolean(r.given_at) })),
    badges: badgeStates({ bestStreak: bestStreak(), wordsLearned, totalStars: stars }),
    freezesLeft: freezesLeft(today),
    wordsLearned,
    recentWords,
    sessions: totals.sessions,
    minutesPractised: Math.ceil(minutes.ms / 60000),
    targetMinutes: targetMinutes(),
    last14: Array.from({ length: 14 }, (_, i) => {
      const date = addDays(today, i - 13);
      return { date, status: byDate.get(date) ?? (date === today ? "today" : "none") };
    }),
  });
});
