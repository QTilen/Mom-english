import { db, getSetting, nowIso } from "../db";
import { levelLabel, SKILL_LABELS_SL, type Skill } from "../levels";
import { grade, type Answer, type GradeResult } from "../content/grade";
import { CATEGORY_LABELS_SL, type Category, type Exercise } from "../content/schema";
import { getExercise, publicView } from "../content/store";
import { addDays, localDate } from "../util/dates";
import { enqueue } from "../jobs/queue";
import { adaptLevels, type LevelChange } from "./adapt";
import { bestStreak, currentStreak, freezesLeft, markDayCompleted, maybeDropBack, maybeStepUp, settleDays, targetMinutes, type TargetChange } from "./habit";
import { getLevels } from "./levels";
import { learnerName, greeting, quoteForDay, type Phrase } from "../content/encouragement";
import { maybeUnlockReward, rewardProgress, starsFor, takeNewBadges, totalStars } from "./rewards";
import { dueCards, recordRight, recordWords, recordWrong, wordKeys, wordsLearnedCount } from "./memory";
import { estimateSeconds, pickFromBank, pickReviewExercise, planBlueprint, planSlots, RECAP_SECONDS, type Blueprint, type Slot } from "./planner";

export interface RecapPoint {
  sl: string;
  en: string;
}

interface SessionRow {
  id: number;
  status: string;
  generated_by: string;
  target_minutes: number;
  blueprint_json: string;
  recap_json: string | null;
  summary_json: string | null;
  local_date: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ItemRow {
  id: number;
  session_id: number;
  position: number;
  phase: "recap" | "main";
  kind: "new" | "review";
  exercise_id: number;
}

// --- Creating sessions ----------------------------------------------------------

// Stores a prepared session, replacing any prepared one she hasn't started.
export function createSession(
  blueprint: Blueprint,
  exerciseIds: number[],
  recap: RecapPoint[] | null,
  generatedBy: "claude" | "bank",
): number {
  return db.transaction(() => {
    db.prepare("UPDATE sessions SET status = 'discarded' WHERE status = 'ready'").run();
    const info = db
      .prepare(
        "INSERT INTO sessions (status, generated_by, target_minutes, blueprint_json, recap_json, created_at) VALUES ('ready', ?, ?, ?, ?, ?)",
      )
      .run(generatedBy, blueprint.targetMinutes, JSON.stringify(blueprint), recap ? JSON.stringify(recap) : null, nowIso());
    const sessionId = Number(info.lastInsertRowid);
    exerciseIds.forEach((exId, i) => insertItem(sessionId, i + 100, "main", "new", exId));
    return sessionId;
  })();
}

function insertItem(sessionId: number, position: number, phase: string, kind: string, exerciseId: number): void {
  db.prepare("INSERT INTO session_items (session_id, position, phase, kind, exercise_id) VALUES (?, ?, ?, ?, ?)").run(
    sessionId,
    position,
    phase,
    kind,
    exerciseId,
  );
}

export function fillSlotsFromBank(slots: Slot[], exclude = new Set<number>()): number[] {
  const ids: number[] = [];
  for (const slot of slots) {
    const ex = pickFromBank(slot, exclude);
    if (ex) {
      ids.push(ex.id);
      exclude.add(ex.id);
    }
  }
  return ids;
}

// Instant, Claude-free session from the stored bank. Used when nothing was
// prepared in time, or Claude is unavailable.
export function createBankSession(today = localDate()): number {
  const blueprint = planBlueprint(getLevels(), targetMinutes(), today);
  return createSession(blueprint, fillSlotsFromBank(blueprint.slots), null, "bank");
}

export function readySessionExists(): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sessions WHERE status IN ('ready', 'in_progress') LIMIT 1").get());
}

// --- Serving today's session ---------------------------------------------------

function lastCompleted(beforeId?: number): SessionRow | undefined {
  return db
    .prepare(`SELECT * FROM sessions WHERE status = 'completed' ${beforeId ? "AND id < ?" : ""} ORDER BY completed_at DESC LIMIT 1`)
    .get(...(beforeId ? [beforeId] : [])) as SessionRow | undefined;
}

function sessionItems(sessionId: number): ItemRow[] {
  return db.prepare("SELECT * FROM session_items WHERE session_id = ? ORDER BY phase = 'main', position").all(sessionId) as ItemRow[];
}

function mainSeconds(sessionId: number): number {
  const items = sessionItems(sessionId).filter((i) => i.phase === "main");
  return estimateSeconds(items.map((i) => getExercise(i.exercise_id).type));
}

// The session was planned for the target length at the time; if the target
// has changed since (a step up or a drop back), trim or top it up from the bank.
function fitToTarget(sessionId: number, minutes: number, today: string): void {
  const budget = minutes * 60 - RECAP_SECONDS;
  const items = sessionItems(sessionId).filter((i) => i.phase === "main");
  let est = mainSeconds(sessionId);
  for (let i = items.length - 1; est > budget * 1.15 && i >= 3; i--) {
    est -= estimateSeconds([getExercise(items[i].exercise_id).type]);
    db.prepare("DELETE FROM session_items WHERE id = ?").run(items[i].id);
  }
  if (est < budget * 0.8) {
    const extra = planSlots(getLevels(), budget - est, today, 0, minutes);
    const exclude = new Set(items.map((i) => i.exercise_id));
    const ids = fillSlotsFromBank(extra, exclude);
    const maxPos = Math.max(100, ...items.map((i) => i.position));
    ids.forEach((id, k) => insertItem(sessionId, maxPos + 1 + k, "main", "new", id));
  }
  db.prepare("UPDATE sessions SET target_minutes = ? WHERE id = ?").run(minutes, sessionId);
}

// One or two quick questions on what is due for review, or else on what she
// did last time.
function addRecapQuestions(sessionId: number, today: string): void {
  const levels = getLevels();
  const maxLevel = Math.max(...Object.values(levels));
  const exclude = new Set(sessionItems(sessionId).map((i) => i.exercise_id));
  const picks: number[] = [];
  for (const card of dueCards(today, 6)) {
    if (picks.length >= 2) break;
    let exId: number | undefined;
    if (card.last_exercise_id) {
      const ex = getExercise(card.last_exercise_id);
      if (["mc", "fill", "order", "match"].includes(ex.type) && !exclude.has(ex.id)) exId = ex.id;
    }
    exId ??= pickReviewExercise(card.key, maxLevel, exclude)?.id;
    if (exId && !picks.includes(exId)) {
      picks.push(exId);
      exclude.add(exId);
    }
  }
  if (picks.length === 0) {
    const prev = lastCompleted(sessionId);
    if (prev) {
      const quick = sessionItems(prev.id)
        .filter((i) => i.phase === "main")
        .map((i) => getExercise(i.exercise_id))
        .filter((ex) => ["mc", "fill", "order", "match"].includes(ex.type) && !exclude.has(ex.id));
      picks.push(...quick.sort(() => Math.random() - 0.5).slice(0, 2).map((e) => e.id));
    }
  }
  picks.forEach((id, k) => insertItem(sessionId, k, "recap", "review", id));
}

// A lesson from one of the uploaded screenshots (her favourite shops, travel
// sites): the newest one she hasn't done, else one not seen for a while.
// Longer sessions also get its word exercises.
function addPictureLesson(sessionId: number, minutes: number): void {
  const row = db
    .prepare(
      `SELECT i.exercise_ids_json FROM images i
       WHERE i.status = 'ready' AND i.exercise_ids_json IS NOT NULL
       ORDER BY
         (SELECT COUNT(*) FROM attempts a WHERE a.exercise_id = json_extract(i.exercise_ids_json, '$[0]')),
         (SELECT MAX(created_at) FROM attempts a WHERE a.exercise_id = json_extract(i.exercise_ids_json, '$[0]')),
         i.id DESC
       LIMIT 1`,
    )
    .get() as { exercise_ids_json: string } | undefined;
  if (!row) return;
  const [pictureId, ...practice] = JSON.parse(row.exercise_ids_json) as number[];
  const recent = db
    .prepare("SELECT 1 FROM attempts WHERE exercise_id = ? AND created_at >= ?")
    .get(pictureId, new Date(Date.now() - 10 * 86_400_000).toISOString());
  if (recent) return;
  insertItem(sessionId, 90, "main", "new", pictureId);
  if (minutes >= 9) practice.slice(0, minutes >= 20 ? 3 : 1).forEach((id, k) => insertItem(sessionId, 91 + k, "main", "new", id));
}

function startSession(sessionId: number, today: string): TargetChange | undefined {
  const dropBack = maybeDropBack(today);
  addPictureLesson(sessionId, targetMinutes());
  fitToTarget(sessionId, targetMinutes(), today);
  addRecapQuestions(sessionId, today);
  db.prepare("UPDATE sessions SET status = 'in_progress', started_at = ? WHERE id = ?").run(nowIso(), sessionId);
  return dropBack;
}

// Encouragement is in English (more reading practice), with the Slovenian
// shown on hover. Explanations and instructions stay in Slovenian.
const correctMessages = (name: string): Phrase[] => [
  { en: "Excellent!", sl: "Odlično!" },
  { en: "Well done!", sl: "Bravo!" },
  { en: "That's right!", sl: "Tako je!" },
  { en: "Very good!", sl: "Zelo dobro!" },
  { en: "Great – correct!", sl: "Super, pravilno!" },
  { en: `Well done, ${name}!`, sl: `Bravo, ${name}!` },
  { en: `That's right, ${name}!`, sl: `Tako je, ${name}!` },
];
const wrongMessages = (name: string): Phrase[] => [
  { en: "Don't worry – mistakes help us learn.", sl: "Nič hudega – napake nam pomagajo pri učenju." },
  { en: "Not quite yet, but that's OK.", sl: "Ni še čisto prav, pa nič hudega." },
  { en: "Almost! Let's look at it together.", sl: "Skoraj! Poglejmo skupaj." },
  { en: `No problem, ${name} – let's look together.`, sl: `Nič hudega, ${name} – poglejmo skupaj.` },
];
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

export interface Feedback {
  outcome: GradeResult["outcome"];
  // Warm English phrase with its translation; pending answers get a plain
  // Slovenian note (message_sl) instead, since it explains what happens next.
  message?: Phrase;
  message_sl?: string;
  correctDisplay: string[];
  explanation_sl?: string;
  note_sl?: string;
}

function feedbackFor(result: GradeResult, ex: Exercise): Feedback {
  switch (result.outcome) {
    case "correct":
      return { outcome: "correct", message: pick(correctMessages(learnerName())), correctDisplay: result.correctDisplay };
    case "almost":
      return { outcome: "almost", message: { en: "Almost perfect!", sl: "Skoraj popolno!" }, note_sl: result.note_sl, correctDisplay: result.correctDisplay, explanation_sl: undefined };
    case "partial":
      return { outcome: "partial", message: { en: "Partly right – nice!", sl: "Del je pravilen – lepo!" }, correctDisplay: result.correctDisplay, explanation_sl: ex.explanation_sl };
    case "incorrect":
      return { outcome: "incorrect", message: pick(wrongMessages(learnerName())), correctDisplay: result.correctDisplay, explanation_sl: ex.explanation_sl };
    case "pending":
      return ex.type === "write"
        ? { outcome: "pending", message_sl: "Hvala za tvoje besedilo! Popravke in nasvete boš videla ob naslednji vaji.", correctDisplay: [] }
        : {
            outcome: "pending",
            message_sl: "Hvala! Tvoj prevod si bomo še natančno ogledali – rezultat boš videla ob naslednji vaji. Eden od možnih odgovorov:",
            correctDisplay: result.correctDisplay,
          };
  }
}

function recapFor(session: SessionRow, today: string) {
  const prev = lastCompleted(session.id);
  const stored: RecapPoint[] | null = session.recap_json ? JSON.parse(session.recap_json) : null;
  let points: RecapPoint[] = stored ?? [];
  if (!stored && prev?.summary_json) {
    const summary = JSON.parse(prev.summary_json) as SessionSummary;
    points = summary.learned.map((l) => ({ sl: l.label_sl, en: l.example_en }));
  }
  const title = !prev
    ? "Začnimo!"
    : prev.local_date === addDays(today, -1)
      ? "Včeraj smo se naučili"
      : "Zadnjič smo se naučili";
  const feedback = (
    db
      .prepare("SELECT id, kind, prompt_json, text, result_json FROM writing_reviews WHERE status = 'graded' AND seen = 0 ORDER BY id")
      .all() as { id: number; kind: string; prompt_json: string; text: string; result_json: string }[]
  ).map((r) => {
    const prompt = JSON.parse(r.prompt_json) as Exercise;
    const result = JSON.parse(r.result_json);
    return {
      id: r.id,
      kind: r.kind,
      prompt_sl: prompt.type === "write" ? prompt.prompt_sl : prompt.type === "translate" ? prompt.sl : "",
      text: r.text,
      corrected: result.corrected_text as string,
      explanation_sl: result.explanation_sl as string,
      praise_sl: result.praise_sl as string | undefined,
      score: result.score as number | undefined,
      correct: result.correct as boolean | undefined,
    };
  });
  return {
    title,
    intro_sl: prev ? undefined : "Danes začnemo s prvo pravo vajo. Vzemi si nekaj minut in uživaj!",
    points,
    feedback,
  };
}

export function markFeedbackSeen(ids: number[]): void {
  const stmt = db.prepare("UPDATE writing_reviews SET seen = 1 WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

function itemPayload(item: ItemRow) {
  const ex = getExercise(item.exercise_id);
  const attempt = db.prepare("SELECT feedback_json, answer_json FROM attempts WHERE session_item_id = ?").get(item.id) as
    | { feedback_json: string; answer_json: string }
    | undefined;
  return {
    id: item.id,
    phase: item.phase,
    kind: item.kind,
    skill: ex.skill,
    view: publicView(ex.content, item.id * 7919 + ex.id),
    feedback: attempt ? JSON.parse(attempt.feedback_json) : undefined,
    answer: attempt ? JSON.parse(attempt.answer_json) : undefined,
  };
}

export function todayState() {
  const today = localDate();
  if (getSetting("placement_done") !== "1") return { screen: "placement" as const };
  settleDays(today);

  const doneToday = db
    .prepare("SELECT * FROM sessions WHERE status = 'completed' AND local_date = ? ORDER BY id DESC LIMIT 1")
    .get(today) as SessionRow | undefined;
  const placementToday = !doneToday && (db.prepare("SELECT status FROM days WHERE date = ?").get(today) as { status: string } | undefined)?.status === "completed";
  if (doneToday || placementToday) {
    const streak = currentStreak(today);
    return {
      screen: "done" as const,
      summary: doneToday?.summary_json ? JSON.parse(doneToday.summary_json) : undefined,
      streak,
      ...personal(today, streak),
    };
  }

  let session = db.prepare("SELECT * FROM sessions WHERE status = 'in_progress' ORDER BY id DESC LIMIT 1").get() as SessionRow | undefined;
  let dropBack: TargetChange | undefined;
  if (!session) {
    let ready = db.prepare("SELECT * FROM sessions WHERE status = 'ready' ORDER BY id DESC LIMIT 1").get() as SessionRow | undefined;
    if (!ready) {
      createBankSession(today);
      ready = db.prepare("SELECT * FROM sessions WHERE status = 'ready' ORDER BY id DESC LIMIT 1").get() as SessionRow;
    }
    dropBack = startSession(ready.id, today);
    session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(ready.id) as SessionRow;
  }

  return {
    screen: "session" as const,
    session: { id: session.id, targetMinutes: session.target_minutes, generatedBy: session.generated_by },
    recap: recapFor(session, today),
    items: sessionItems(session.id).map(itemPayload),
    streak: currentStreak(today),
    dropBack,
    ...personal(today, currentStreak(today)),
  };
}

// Name, greeting, the thought for the day and how close the next reward is.
function personal(today: string, streak: number) {
  return { name: learnerName(), greeting: greeting(), quote: quoteForDay(today), reward: rewardProgress(streak) };
}

// --- Answering -----------------------------------------------------------------

export function answerItem(sessionId: number, itemId: number, answer: Answer, ms: number | null): Feedback {
  const item = db.prepare("SELECT * FROM session_items WHERE id = ? AND session_id = ?").get(itemId, sessionId) as ItemRow | undefined;
  if (!item) throw new Error("item not in session");
  const existing = db.prepare("SELECT feedback_json FROM attempts WHERE session_item_id = ?").get(itemId) as
    | { feedback_json: string }
    | undefined;
  if (existing) return JSON.parse(existing.feedback_json);

  const ex = getExercise(item.exercise_id);
  const today = localDate();
  const result = grade(ex.content, answer, ex.skill);
  const feedback = feedbackFor(result, ex.content);

  db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO attempts (session_item_id, exercise_id, skill, type, answer_json, correct, score, feedback_json, ms, local_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        ex.id,
        ex.skill,
        ex.type,
        JSON.stringify(answer),
        result.correct === null ? null : result.correct ? 1 : 0,
        result.score,
        JSON.stringify(feedback),
        ms,
        today,
        nowIso(),
      );
    const attemptId = Number(info.lastInsertRowid);
    const given = describeAnswer(answer);

    if (result.outcome === "pending") {
      const r = db
        .prepare(
          "INSERT INTO writing_reviews (kind, attempt_id, prompt_json, text, level, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(ex.type === "write" ? "write" : "translate", attemptId, JSON.stringify(ex.content), given, ex.level, nowIso());
      enqueue(ex.type === "write" ? "grade_writing" : "grade_translation", { reviewId: Number(r.lastInsertRowid) });
    } else if (result.correct) {
      recordRight([...ex.content.categories, ...wordKeys(ex.content.words)], today);
      recordWords(ex.content.words, true, today);
      if (result.outcome === "almost") logMistakes(attemptId, ["writing:spelling"], given);
    } else {
      logMistakes(attemptId, result.wrongCategories, given);
      recordWrong([...result.wrongCategories, ...wordKeys(ex.content.words)], ex.id, today);
      recordWords(ex.content.words, false, today);
    }
  })();
  return feedback;
}

function describeAnswer(answer: Answer): string {
  if ("text" in answer) return answer.text.trim().slice(0, 2000);
  if ("option" in answer) return answer.option;
  if ("words" in answer) return answer.words.join(" ");
  if ("matches" in answer) return answer.matches.join(", ");
  return answer.options.join(" | ");
}

export function logMistakes(attemptId: number | null, categories: string[], detail: string): void {
  const stmt = db.prepare("INSERT INTO mistakes (attempt_id, category, detail, created_at) VALUES (?, ?, ?, ?)");
  for (const c of new Set(categories)) stmt.run(attemptId, c, detail.slice(0, 300), nowIso());
}

// --- Completing ----------------------------------------------------------------

export interface SessionSummary {
  correct: number;
  total: number;
  minutes: number;
  learned: { category: string; label_sl: string; example_en: string }[];
  newWords: { en: string; sl: string }[];
  streak: number;
  bestStreak: number;
  freezesLeft: number;
  wordsLearned: number;
  stepUp?: TargetChange;
  levelChanges: (LevelChange & { label_sl: string; fromLabel: string; toLabel: string })[];
  pendingReviews: number;
  stars: number;
  totalStars: number;
  newBadges: ReturnType<typeof takeNewBadges>;
  rewardUnlocked?: { reward_text: string; streak: number };
  reward: ReturnType<typeof rewardProgress>;
  name: string;
}

export function completeSession(sessionId: number): SessionSummary {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
  if (!session) throw new Error("session not found");
  if (session.status === "completed" && session.summary_json) return JSON.parse(session.summary_json);
  const items = sessionItems(sessionId);
  const attempts = db
    .prepare(
      `SELECT a.*, si.phase FROM attempts a JOIN session_items si ON si.id = a.session_item_id WHERE si.session_id = ?`,
    )
    .all(sessionId) as { session_item_id: number; exercise_id: number; correct: number | null; ms: number | null; local_date: string; phase: string; feedback_json: string }[];
  if (attempts.length < items.length) throw new Error("not all items answered");

  const today = localDate();
  db.prepare("UPDATE sessions SET status = 'completed', completed_at = ?, local_date = ? WHERE id = ?").run(nowIso(), today, sessionId);
  markDayCompleted(today);
  const stepUp = maybeStepUp(today);
  const levelChanges = adaptLevels().map((c) => ({
    ...c,
    label_sl: SKILL_LABELS_SL[c.skill as Skill],
    fromLabel: levelLabel(c.from),
    toLabel: levelLabel(c.to),
  }));

  const learned: SessionSummary["learned"] = [];
  const seen = new Set<string>();
  for (const a of attempts.filter((x) => x.phase === "main")) {
    const ex = getExercise(a.exercise_id);
    const fb = JSON.parse(a.feedback_json) as Feedback;
    for (const c of ex.content.categories) {
      if (seen.has(c) || learned.length >= 4) continue;
      seen.add(c);
      // A reading answer ("question → answer") makes a poor example on its own.
      const example = ex.type === "reading" || ex.type === "picture" ? "" : (fb.correctDisplay[0] ?? "");
      learned.push({ category: c, label_sl: CATEGORY_LABELS_SL[c as Category] ?? c, example_en: example });
    }
  }
  const newWords = db.prepare("SELECT en, sl FROM words WHERE first_seen = ? LIMIT 8").all(today) as { en: string; sl: string }[];

  const graded = attempts.filter((a) => a.correct !== null);
  const correct = graded.filter((a) => a.correct === 1).length;
  const stars = starsFor(correct, graded.length);
  db.prepare("UPDATE sessions SET stars = ? WHERE id = ?").run(stars, sessionId);
  const streak = currentStreak(today);
  const unlocked = maybeUnlockReward(today, streak);
  const best = bestStreak();
  const wordsLearned = wordsLearnedCount();
  const starsTotal = totalStars();
  const summary: SessionSummary = {
    correct,
    total: graded.length,
    minutes: Math.max(1, Math.round(attempts.reduce((s, a) => s + (a.ms ?? 0), 0) / 60000)),
    learned,
    newWords,
    streak,
    bestStreak: best,
    freezesLeft: freezesLeft(today),
    wordsLearned,
    stepUp,
    levelChanges,
    pendingReviews: attempts.length - graded.length,
    stars,
    totalStars: starsTotal,
    newBadges: takeNewBadges({ bestStreak: best, wordsLearned, totalStars: starsTotal }),
    rewardUnlocked: unlocked ? { reward_text: unlocked.reward_text, streak: unlocked.streak } : undefined,
    reward: rewardProgress(streak),
    name: learnerName(),
  };
  db.prepare("UPDATE sessions SET summary_json = ? WHERE id = ?").run(JSON.stringify(summary), sessionId);
  enqueue("generate_session", { reason: "after_session", afterSessionId: sessionId });
  return summary;
}

export function getSessionRow(id: number): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export { lastCompleted, sessionItems, type SessionRow, type ItemRow };
