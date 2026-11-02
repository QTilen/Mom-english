import { db, nowIso, setSetting } from "../db";
import { clampLevel, type Skill } from "../levels";
import { grade, type Answer } from "../content/grade";
import { loadPlacementFile, publicView } from "../content/store";
import { localDate } from "../util/dates";
import { enqueue } from "../jobs/queue";
import { getLevels, setLevel } from "./levels";
import { markDayCompleted } from "./habit";

// Adaptive placement: a separate staircase per objective skill (one level up
// after a right answer, one down after a wrong one), then a few free-writing
// prompts chosen around the level she reached. Claude grades the writing later.

export const OBJECTIVE_SKILLS = ["vocabulary", "grammar", "reading"] as const;
type ObjectiveSkill = (typeof OBJECTIVE_SKILLS)[number];
// 8 per skill + 3 writing prompts ≈ 25–30 minutes: long enough for the
// staircase to settle, and she is told up front it can take up to 30 minutes.
export const ITEMS_PER_SKILL = 8;
const OBJECTIVE_TOTAL = ITEMS_PER_SKILL * OBJECTIVE_SKILLS.length;
const START_LEVEL = 1; // A1.1
// The placement pool covers Pre-A1 … A2.2; higher levels are reached through practice.
const PLACEMENT_MAX_LEVEL = 5;

interface HistoryEntry {
  itemId: string;
  skill: ObjectiveSkill;
  level: number;
  correct: boolean;
  ms: number | null;
}

export interface PlacementState {
  current: Record<ObjectiveSkill, number>;
  history: HistoryEntry[];
  // Item or writing prompt she is looking at now.
  pending: { kind: "item"; itemId: string } | { kind: "writing"; index: number } | null;
  writingLevels: number[];
  writingDone: number;
}

// Final level for one skill: average "achieved" level over her last four
// items (the item's level if right, one below if wrong), rounded down. This
// deliberately errs low so the first sessions feel easy.
export function estimateLevel(entries: { level: number; correct: boolean }[]): number {
  if (entries.length === 0) return START_LEVEL;
  const last = entries.slice(-4).map((e) => (e.correct ? e.level : Math.max(0, e.level - 1)));
  return clampLevel(Math.floor(last.reduce((a, b) => a + b, 0) / last.length));
}

function nextObjective(state: PlacementState): { kind: "item"; itemId: string } | null {
  const answered = state.history.length;
  if (answered >= OBJECTIVE_TOTAL) return null;
  const skill = OBJECTIVE_SKILLS[answered % OBJECTIVE_SKILLS.length];
  const level = state.current[skill];
  const seen = new Set(state.history.map((h) => h.itemId));
  const pool = loadPlacementFile().items.filter((i) => i.skill === skill && !seen.has(i.id));
  // Prefer the exact level; otherwise the nearest one, leaning easier.
  pool.sort((a, b) => Math.abs(a.level - level) - Math.abs(b.level - level) || a.level - b.level);
  const pick = pool.find((i) => i.level === level) ?? pool[0];
  return pick ? { kind: "item", itemId: pick.id } : null;
}

function chooseWritingLevels(state: PlacementState): number[] {
  const avg = Math.floor(
    OBJECTIVE_SKILLS.reduce((sum, s) => sum + estimateLevel(state.history.filter((h) => h.skill === s)), 0) / OBJECTIVE_SKILLS.length,
  );
  // Three different prompts around her level, shifted inwards at the edges.
  const start = Math.max(0, Math.min(PLACEMENT_MAX_LEVEL - 2, avg - 1));
  return [start, start + 1, start + 2];
}

function loadState(attemptId: number): PlacementState {
  const row = db.prepare("SELECT state_json FROM placement_attempts WHERE id = ?").get(attemptId) as
    | { state_json: string }
    | undefined;
  if (!row) throw new Error("placement attempt not found");
  return JSON.parse(row.state_json);
}

function saveState(attemptId: number, state: PlacementState): void {
  db.prepare("UPDATE placement_attempts SET state_json = ? WHERE id = ?").run(JSON.stringify(state), attemptId);
}

export function activeAttemptId(): number | undefined {
  const row = db.prepare("SELECT id FROM placement_attempts WHERE finished_at IS NULL ORDER BY id DESC LIMIT 1").get() as
    | { id: number }
    | undefined;
  return row?.id;
}

// Resumes an unfinished attempt (she may have closed the tab) or starts one.
export function startPlacement(): number {
  const existing = activeAttemptId();
  if (existing) return existing;
  const state: PlacementState = {
    current: { vocabulary: START_LEVEL, grammar: START_LEVEL, reading: START_LEVEL },
    history: [],
    pending: null,
    writingLevels: [],
    writingDone: 0,
  };
  state.pending = nextObjective(state);
  const info = db.prepare("INSERT INTO placement_attempts (started_at, state_json) VALUES (?, ?)").run(nowIso(), JSON.stringify(state));
  return Number(info.lastInsertRowid);
}

function itemSeed(id: string): number {
  return [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

export function placementQuestion(attemptId: number) {
  const state = loadState(attemptId);
  const total = OBJECTIVE_TOTAL + (state.writingLevels.length || 3);
  const done = state.history.length + state.writingDone;
  if (!state.pending) return { attemptId, done: true as const, progress: { done, total } };
  const file = loadPlacementFile();
  if (state.pending.kind === "item") {
    const itemId = state.pending.itemId;
    const item = file.items.find((i) => i.id === itemId)!;
    return { attemptId, done: false as const, progress: { done, total }, key: itemId, view: publicView(item.exercise, itemSeed(itemId)) };
  }
  const level = state.writingLevels[state.pending.index];
  const prompt = file.writing.find((w) => w.level === level)!;
  return {
    attemptId,
    done: false as const,
    progress: { done, total },
    key: `w${state.pending.index}`,
    view: publicView(prompt.exercise, 1),
  };
}

export type PlacementAnswer = (Answer & { skip?: false }) | { skip: true };

export function answerPlacement(attemptId: number, key: string, answer: PlacementAnswer, ms: number | null) {
  const state = loadState(attemptId);
  const pending = state.pending;
  if (!pending) return placementQuestion(attemptId);
  const pendingKey = pending.kind === "item" ? pending.itemId : `w${pending.index}`;
  // A double submit (or a stale tab) shouldn't advance the test twice.
  if (key !== pendingKey) return placementQuestion(attemptId);

  const file = loadPlacementFile();
  if (pending.kind === "item") {
    const item = file.items.find((i) => i.id === pending.itemId)!;
    const skill = item.skill as ObjectiveSkill;
    const correct = !("skip" in answer && answer.skip) && grade(item.exercise, answer as Answer, skill).correct === true;
    state.history.push({ itemId: item.id, skill, level: item.level, correct, ms });
    state.current[skill] = Math.max(0, Math.min(PLACEMENT_MAX_LEVEL, state.current[skill] + (correct ? 1 : -1)));
    state.pending = nextObjective(state);
    if (!state.pending) {
      state.writingLevels = chooseWritingLevels(state);
      state.pending = { kind: "writing", index: 0 };
    }
  } else {
    const level = state.writingLevels[pending.index];
    const prompt = file.writing.find((w) => w.level === level)!;
    const text = "text" in answer ? answer.text.trim() : "";
    if (text) {
      const info = db
        .prepare(
          "INSERT INTO writing_reviews (kind, placement_attempt_id, prompt_json, text, level, status, created_at) VALUES ('write', ?, ?, ?, ?, 'pending', ?)",
        )
        .run(attemptId, JSON.stringify(prompt.exercise), text, level, nowIso());
      enqueue("grade_writing", { reviewId: Number(info.lastInsertRowid) });
    }
    state.writingDone++;
    const next = pending.index + 1;
    state.pending = next < state.writingLevels.length ? { kind: "writing", index: next } : null;
  }
  saveState(attemptId, state);
  if (!state.pending) finishPlacement(attemptId, state);
  return placementQuestion(attemptId);
}

function finishPlacement(attemptId: number, state: PlacementState): void {
  const levels: Record<Skill, number> = { vocabulary: 0, grammar: 0, reading: 0, writing: 0 };
  for (const skill of OBJECTIVE_SKILLS) levels[skill] = estimateLevel(state.history.filter((h) => h.skill === skill));
  const objectiveAvg = Math.floor((levels.vocabulary + levels.grammar + levels.reading) / 3);
  // Provisional until Claude has read her writing; see applyPlacementWriting.
  levels.writing = Math.max(0, objectiveAvg - 1);

  db.transaction(() => {
    for (const [skill, level] of Object.entries(levels)) setLevel(skill as Skill, level, "placement");
    db.prepare("UPDATE placement_attempts SET finished_at = ?, result_json = ? WHERE id = ?").run(
      nowIso(),
      JSON.stringify({ levels, writingProvisional: true }),
      attemptId,
    );
    setSetting("placement_done", "1");
    setSetting("target_minutes", 5);
    setSetting("target_changed_on", localDate());
    // Doing the placement test counts as her first day.
    markDayCompleted(localDate());
  })();
  enqueue("generate_session", { reason: "placement" });
}

// Called after each placement writing review is graded. Once every review for
// the attempt is settled, the median CEFR estimate becomes her writing level,
// unless the writing level has already moved on through normal practice.
export function applyPlacementWriting(attemptId: number): void {
  const reviews = db
    .prepare("SELECT status, result_json FROM writing_reviews WHERE placement_attempt_id = ?")
    .all(attemptId) as { status: string; result_json: string | null }[];
  if (reviews.length === 0 || reviews.some((r) => r.status === "pending")) return;
  const estimates = reviews
    .filter((r) => r.status === "graded" && r.result_json)
    .map((r) => JSON.parse(r.result_json!).levelIndex as number)
    .filter((n) => typeof n === "number")
    .sort((a, b) => a - b);
  if (estimates.length === 0) return;
  const movedSince = db
    .prepare("SELECT COUNT(*) AS n FROM level_history WHERE skill = 'writing' AND reason != 'placement'")
    .get() as { n: number };
  if (movedSince.n > 0) return;
  const median = estimates[Math.floor((estimates.length - 1) / 2)];
  setLevel("writing", median, "placement_writing");
  const row = db.prepare("SELECT result_json FROM placement_attempts WHERE id = ?").get(attemptId) as { result_json: string | null };
  const result = row.result_json ? JSON.parse(row.result_json) : {};
  result.levels = { ...(result.levels ?? {}), writing: median };
  result.writingProvisional = false;
  db.prepare("UPDATE placement_attempts SET result_json = ? WHERE id = ?").run(JSON.stringify(result), attemptId);
}

export function placementResult(): { levels: Record<Skill, number>; writingPending: boolean } | undefined {
  const row = db
    .prepare("SELECT id FROM placement_attempts WHERE result_json IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  if (!row) return undefined;
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM writing_reviews WHERE placement_attempt_id = ? AND status = 'pending'")
    .get(row.id) as { n: number };
  return { levels: getLevels(), writingPending: pending.n > 0 };
}

export function resetPlacement(): void {
  // Abandon any half-done attempt; it has no result_json, so it never counts.
  db.prepare("UPDATE placement_attempts SET finished_at = ? WHERE finished_at IS NULL").run(nowIso());
  setSetting("placement_done", "0");
}
