import { z } from "zod";
import { db, nowIso } from "../db";
import { LEVELS, levelLabel, parseLevelLabel, SKILLS, type Skill } from "../levels";
import { callClaudeJson } from "../claude/run";
import { GENERATOR_SYSTEM, GRADER_SYSTEM, withName } from "../claude/prompts";
import { learnerName } from "../content/encouragement";
import { CategorySchema, CATEGORY_LABELS_SL, ExerciseSchema, exerciseProblems, TOPICS, type Exercise } from "../content/schema";
import { getExercise, saveExercise } from "../content/store";
import { addDays, localDate } from "../util/dates";
import { adaptLevels } from "../engine/adapt";
import { targetMinutes } from "../engine/habit";
import { getLevels } from "../engine/levels";
import { recordRight, recordWords, recordWrong, wordKeys } from "../engine/memory";
import { applyPlacementWriting } from "../engine/placement";
import { planBlueprint, type Slot } from "../engine/planner";
import { createBankSession, createSession, lastCompleted, logMistakes, sessionItems, type RecapPoint } from "../engine/session";
import { registerJob } from "./queue";

const text = (max: number) => z.string().trim().min(1).max(max);

// --- Generation -----------------------------------------------------------------

const RecapSchema = z.array(z.object({ sl: text(120), en: text(160) })).max(4);

function describeSlots(slots: Slot[]): string {
  return slots
    .map((s, i) => {
      const focus = s.focus ? `, focus: ${s.focus} (${CATEGORY_LABELS_SL[s.focus]})` : "";
      return `${i + 1}. type: ${s.type}, skill: ${s.skill}, level: ${levelLabel(s.level)}, topic: ${s.topic}${focus}`;
    })
    .join("\n");
}

function slotProblems(items: Exercise[], slots: Slot[]): string[] {
  const p: string[] = [];
  if (items.length !== slots.length) p.push(`items must contain exactly ${slots.length} exercises, one per slot, in order`);
  items.forEach((it, i) => {
    const slot = slots[i];
    if (slot && it.type !== slot.type) p.push(`items[${i}] must have type "${slot.type}"`);
    p.push(...exerciseProblems(it, `items[${i}]`));
  });
  return p;
}

function recentMistakesText(): string {
  const rows = db
    .prepare(
      `SELECT m.category, m.detail, a.feedback_json FROM mistakes m LEFT JOIN attempts a ON a.id = m.attempt_id
       ORDER BY m.id DESC LIMIT 15`,
    )
    .all() as { category: string; detail: string | null; feedback_json: string | null }[];
  if (rows.length === 0) return "none yet";
  return rows
    .map((r) => {
      const right = r.feedback_json ? (JSON.parse(r.feedback_json).correctDisplay?.[0] ?? "") : "";
      return `- ${r.category}: she wrote "${r.detail ?? ""}"${right ? `, correct: "${right}"` : ""}`;
    })
    .join("\n");
}

function lastSessionText(): string | undefined {
  const prev = lastCompleted();
  if (!prev) return undefined;
  const lines = sessionItems(prev.id)
    .filter((i) => i.phase === "main")
    .map((i) => {
      const ex = getExercise(i.exercise_id);
      const a = db.prepare("SELECT correct FROM attempts WHERE session_item_id = ?").get(i.id) as { correct: number | null } | undefined;
      const result = a?.correct === 1 ? "right" : a?.correct === 0 ? "wrong" : "not graded yet";
      return `- ${ex.type} on ${ex.content.categories.join("/")} (${ex.topic}): ${result}`;
    });
  return lines.join("\n");
}

async function generateItems(slots: Slot[], purpose: string, withRecap: boolean) {
  const levels = getLevels();
  const last = withRecap ? lastSessionText() : undefined;
  const prompt = `Write exercises for these slots, in this order:
${describeSlots(slots)}

Her current levels: ${SKILLS.map((s) => `${s} ${levelLabel(levels[s])}`).join(", ")}.

Her recent mistakes (practise these points again where a slot's focus allows, with new sentences):
${recentMistakesText()}
${
  withRecap
    ? last
      ? `
Her last session:
${last}

Also write "recap": 2–4 short points reminding her what she practised last time. "sl" is a short Slovenian description of the point (what to remember), "en" a short English example.`
      : `
This is her first session, so "recap" is an empty list.`
    : `
"recap" is an empty list.`
}

Return JSON with "recap" and "items" (exactly ${slots.length} exercises).`;

  const schema = z.object({ recap: RecapSchema, items: z.array(ExerciseSchema) });
  return callClaudeJson({
    purpose,
    system: withName(GENERATOR_SYSTEM, learnerName()),
    prompt,
    schema,
    check: (out) => slotProblems(out.items, slots),
    timeoutMs: 300_000,
  });
}

async function generateSession(): Promise<void> {
  // Planned for her next visit, normally tomorrow.
  const nextDay = addDays(localDate(), 1);
  const blueprint = planBlueprint(getLevels(), targetMinutes(), nextDay);
  try {
    const out = await generateItems(blueprint.slots, "generate_session", true);
    const ids = out.items.map((item, i) => saveExercise(item, blueprint.slots[i].skill, blueprint.slots[i].level, "claude"));
    createSession(blueprint, ids, out.recap as RecapPoint[], "claude");
  } catch (err) {
    // Make sure something is ready for tomorrow either way; a later retry
    // will replace this bank session if she hasn't started it yet.
    const ready = db.prepare("SELECT 1 FROM sessions WHERE status = 'ready'").get();
    if (!ready) createBankSession(nextDay);
    throw err;
  }
}

// Tops up the stored bank for one level with a balanced mix of exercises.
export async function refillBank(level: number): Promise<number> {
  const types: [Skill, Exercise["type"]][] = [
    ["vocabulary", "mc"],
    ["vocabulary", "match"],
    ["vocabulary", "translate"],
    ["vocabulary", "mc"],
    ["grammar", "mc"],
    ["grammar", "fill"],
    ["grammar", "order"],
    ["grammar", "fill"],
    ["reading", "reading"],
    ["writing", "translate"],
    ["writing", "translate"],
    ["writing", "write"],
  ];
  const topics = [...TOPICS].sort(() => Math.random() - 0.5);
  const slots: Slot[] = types.map(([skill, type], i) => ({ skill, type, level, topic: topics[i % topics.length] }));
  const out = await generateItems(slots, "refill_bank", false);
  out.items.forEach((item, i) => saveExercise(item, slots[i].skill, slots[i].level, "claude"));
  return out.items.length;
}

// --- Grading ----------------------------------------------------------------------

const MistakeSchema = z.object({ category: CategorySchema, detail: text(160) });

const WritingGradeSchema = z.object({
  corrected_text: text(3000),
  explanation_sl: text(500),
  praise_sl: text(200),
  score: z.number().int().min(0).max(100),
  cefr: z.enum(LEVELS),
  mistakes: z.array(MistakeSchema).max(6),
});

const TranslationGradeSchema = z.object({
  correct: z.boolean(),
  corrected_text: text(400),
  explanation_sl: text(400),
  praise_sl: text(200).optional(),
  mistakes: z.array(MistakeSchema).max(4),
});

interface ReviewRow {
  id: number;
  kind: "write" | "translate";
  attempt_id: number | null;
  placement_attempt_id: number | null;
  prompt_json: string;
  text: string;
  level: number;
}

function loadReview(reviewId: number): ReviewRow | undefined {
  return db.prepare("SELECT * FROM writing_reviews WHERE id = ? AND status = 'pending'").get(reviewId) as ReviewRow | undefined;
}

function settleAttempt(review: ReviewRow, correct: boolean, score: number, mistakes: { category: string; detail: string }[]): void {
  if (!review.attempt_id) return;
  const attempt = db.prepare("SELECT exercise_id FROM attempts WHERE id = ?").get(review.attempt_id) as { exercise_id: number };
  const ex = getExercise(attempt.exercise_id);
  const today = localDate();
  db.prepare("UPDATE attempts SET correct = ?, score = ? WHERE id = ?").run(correct ? 1 : 0, score, review.attempt_id);
  if (mistakes.length) {
    for (const m of mistakes) logMistakes(review.attempt_id, [m.category], m.detail);
    recordWrong(mistakes.map((m) => m.category), ex.id, today);
  }
  if (correct) {
    recordRight([...ex.content.categories, ...wordKeys(ex.content.words)], today);
    recordWords(ex.content.words, true, today);
  } else {
    recordWords(ex.content.words, false, today);
  }
  adaptLevels();
}

async function gradeWriting(payload: { reviewId: number }): Promise<void> {
  const review = loadReview(payload.reviewId);
  if (!review) return;
  const prompt = JSON.parse(review.prompt_json) as Exercise;
  const task = prompt.type === "write" ? prompt.prompt_sl : "";
  const out = await callClaudeJson({
    purpose: review.placement_attempt_id ? "grade_placement_writing" : "grade_writing",
    system: withName(GRADER_SYSTEM, learnerName()),
    prompt: `The task (in Slovenian) was: "${task}"
Expected level of the task: ${levelLabel(review.level)}.

Her text:
"""
${review.text}
"""

Return JSON:
- corrected_text: her text with mistakes corrected (minimal changes).
- explanation_sl: 2–3 short Slovenian sentences on the one or two most useful corrections, with the rule.
- praise_sl: one short, specific, encouraging Slovenian sentence about what she did well.
- score: 0–100 for how well she did this task at this level (content and accuracy together; a short but correct answer can score high).
- cefr: the CEFR sub-level her writing shows (${LEVELS.join(", ")}).
- mistakes: up to 5 of her mistakes, each with a category from the allowed list and a short "wrong → right" detail. Empty if none.`,
    schema: WritingGradeSchema,
  });
  const levelIndex = parseLevelLabel(out.cefr) ?? review.level;
  db.prepare("UPDATE writing_reviews SET status = 'graded', result_json = ?, graded_at = ? WHERE id = ?").run(
    JSON.stringify({ ...out, levelIndex }),
    nowIso(),
    review.id,
  );
  settleAttempt(review, out.score >= 60, out.score / 100, out.mistakes);
  if (review.placement_attempt_id) applyPlacementWriting(review.placement_attempt_id);
}

async function gradeTranslation(payload: { reviewId: number }): Promise<void> {
  const review = loadReview(payload.reviewId);
  if (!review) return;
  const ex = JSON.parse(review.prompt_json) as Exercise;
  if (ex.type !== "translate") return;
  const out = await callClaudeJson({
    purpose: "grade_translation",
    system: withName(GRADER_SYSTEM, learnerName()),
    prompt: `She was asked to translate this Slovenian sentence into English (level ${levelLabel(review.level)}):
"${ex.sl}"

Example correct answers: ${ex.accepted.map((a) => `"${a}"`).join(", ")}

Her answer: "${review.text}"

Decide whether her answer is a correct translation (it may differ from the examples; small slips like a missing full stop or capital letter don't matter, but grammar and meaning do).
Return JSON:
- correct: true or false.
- corrected_text: her answer, minimally corrected (unchanged if already correct).
- explanation_sl: one or two short Slovenian sentences explaining the correction, or confirming it's right.
- praise_sl: optional short encouraging Slovenian sentence.
- mistakes: her mistakes with categories from the allowed list and a short "wrong → right" detail; empty if correct.`,
    schema: TranslationGradeSchema,
  });
  db.prepare("UPDATE writing_reviews SET status = 'graded', result_json = ?, graded_at = ? WHERE id = ?").run(
    JSON.stringify(out),
    nowIso(),
    review.id,
  );
  settleAttempt(review, out.correct, out.correct ? 1 : 0, out.mistakes);
}

export function registerJobs(): void {
  registerJob("generate_session", generateSession);
  registerJob("refill_bank", async (p: { level: number }) => {
    await refillBank(p.level);
  });
  registerJob("grade_writing", gradeWriting, markReviewFailed);
  registerJob("grade_translation", gradeTranslation, markReviewFailed);
}

// When grading has given up for good, stop treating the answer as "waiting";
// it simply won't count towards her levels.
function markReviewFailed(payload: { reviewId: number }): void {
  db.prepare("UPDATE writing_reviews SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payload.reviewId);
  const row = db.prepare("SELECT placement_attempt_id FROM writing_reviews WHERE id = ?").get(payload.reviewId) as
    | { placement_attempt_id: number | null }
    | undefined;
  if (row?.placement_attempt_id) applyPlacementWriting(row.placement_attempt_id);
}
