import { db } from "../db";
import { SKILLS, type Skill } from "../levels";
import { CATEGORIES, TOPICS, type Category, type ExerciseType, type Topic } from "../content/schema";
import { queryExercises, type ExerciseRow } from "../content/store";
import { addDays } from "../util/dates";
import { dueCards } from "./memory";
import type { Levels } from "./levels";

// Decides what a session contains (how many items, which skills, types,
// levels, topics and weak points to target). Claude only writes the content
// for these slots, so a session is well-shaped even when it comes from the bank.

export interface Slot {
  type: ExerciseType;
  skill: Skill;
  level: number;
  topic: Topic;
  focus?: Category;
}

export interface Blueprint {
  targetMinutes: number;
  slots: Slot[];
}

export const RECAP_SECONDS = 45;
const MIN_MAIN_ITEMS = 3;

const DEFAULT_SECONDS: Record<ExerciseType, number> = {
  mc: 20,
  fill: 30,
  order: 40,
  match: 45,
  translate: 60,
  reading: 120,
  write: 180,
};

const TYPES_BY_SKILL: Record<Skill, ExerciseType[]> = {
  vocabulary: ["mc", "match", "translate"],
  grammar: ["mc", "fill", "order"],
  reading: ["reading"],
  writing: ["translate", "write"],
};

// Her own median time per exercise type once there's enough data, so a
// "5 minute" session really takes about five minutes for her.
export function secondsFor(type: ExerciseType): number {
  const rows = db
    .prepare("SELECT ms FROM attempts WHERE type = ? AND ms IS NOT NULL ORDER BY id DESC LIMIT 20")
    .all(type) as { ms: number }[];
  const fallback = DEFAULT_SECONDS[type];
  if (rows.length < 5) return fallback;
  const sorted = rows.map((r) => r.ms / 1000).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.round(Math.max(fallback * 0.5, Math.min(fallback * 3, median)));
}

function recentErrorRate(skill: Skill, today: string): number {
  const row = db
    .prepare("SELECT AVG(1 - COALESCE(score, correct)) AS err FROM attempts WHERE skill = ? AND correct IS NOT NULL AND local_date >= ?")
    .get(skill, addDays(today, -14)) as { err: number | null };
  return row.err ?? 0;
}

// Weaker skills (relative to her best) and skills with recent errors get more
// time, but every skill keeps a share so nothing is neglected.
export function skillWeights(levels: Levels, today: string): Record<Skill, number> {
  const best = Math.max(...SKILLS.map((s) => levels[s]));
  const raw = Object.fromEntries(
    SKILLS.map((s) => [s, 1 + 0.6 * (best - levels[s]) + 2 * recentErrorRate(s, today)]),
  ) as Record<Skill, number>;
  const total = SKILLS.reduce((sum, s) => sum + raw[s], 0);
  const weights = Object.fromEntries(SKILLS.map((s) => [s, Math.max(0.15, raw[s] / total)])) as Record<Skill, number>;
  const norm = SKILLS.reduce((sum, s) => sum + weights[s], 0);
  for (const s of SKILLS) weights[s] /= norm;
  return weights;
}

function recentTopics(): Topic[] {
  const rows = db.prepare("SELECT blueprint_json FROM sessions ORDER BY id DESC LIMIT 5").all() as { blueprint_json: string }[];
  return rows.flatMap((r) => (JSON.parse(r.blueprint_json) as Blueprint).slots.map((s) => s.topic));
}

function topicRotation(): Topic[] {
  const recent = recentTopics();
  const uses = (t: Topic) => recent.filter((r) => r === t).length;
  return [...TOPICS].sort((a, b) => uses(a) - uses(b) || Math.random() - 0.5);
}

function categorySkill(cat: Category): Skill[] {
  if (cat.startsWith("grammar:")) return ["grammar", "writing"];
  if (cat.startsWith("vocab:")) return ["vocabulary"];
  if (cat.startsWith("reading:")) return ["reading"];
  return ["writing"];
}

// Weak points to aim new items at: spaced-repetition cards due now, then the
// categories she has got wrong most in the last two weeks.
export function focusCategories(today: string): Category[] {
  const valid = new Set<string>(CATEGORIES);
  const due = dueCards(today, 20).map((c) => c.key).filter((k) => valid.has(k)) as Category[];
  const frequent = (
    db
      .prepare("SELECT category, COUNT(*) AS n FROM mistakes WHERE created_at >= ? GROUP BY category ORDER BY n DESC LIMIT 6")
      .all(new Date(Date.now() - 14 * 86_400_000).toISOString()) as { category: string }[]
  )
    .map((r) => r.category)
    .filter((k) => valid.has(k)) as Category[];
  return [...new Set([...due, ...frequent])];
}

export function planSlots(levels: Levels, budgetSeconds: number, today: string, minItems = MIN_MAIN_ITEMS, targetMinutes = 5): Slot[] {
  const weights = skillWeights(levels, today);
  const topics = topicRotation();
  const focus = focusCategories(today);
  const spent: Record<Skill, number> = { vocabulary: 0, grammar: 0, reading: 0, writing: 0 };
  const typeUses = new Map<ExerciseType, number>();
  const slots: Slot[] = [];
  let remaining = budgetSeconds;

  const typeFits = (t: ExerciseType) => {
    if (t === "write") {
      // A free-writing task takes a few minutes; only once sessions are long enough.
      return targetMinutes >= 8 && !slots.some((s) => s.type === "write") && secondsFor(t) <= remaining;
    }
    return secondsFor(t) <= remaining;
  };

  for (let guard = 0; guard < 40; guard++) {
    const total = SKILLS.reduce((sum, s) => sum + spent[s], 0) + 1;
    const bySkillNeed = [...SKILLS].sort((a, b) => weights[b] * total - spent[b] - (weights[a] * total - spent[a]));
    let chosen: { skill: Skill; type: ExerciseType } | undefined;
    for (const skill of bySkillNeed) {
      const types = TYPES_BY_SKILL[skill]
        .filter(typeFits)
        .sort((a, b) => (typeUses.get(a) ?? 0) - (typeUses.get(b) ?? 0) || secondsFor(a) - secondsFor(b));
      if (types.length) {
        chosen = { skill, type: types[0] };
        break;
      }
    }
    if (!chosen) {
      if (slots.length >= minItems) break;
      // Short of the minimum: add a quick multiple-choice item regardless of budget.
      const skill = bySkillNeed.find((s) => s === "vocabulary" || s === "grammar")!;
      chosen = { skill, type: "mc" };
    }
    const focusIdx = focus.findIndex((c) => categorySkill(c).includes(chosen!.skill));
    const slotFocus = focusIdx >= 0 ? focus.splice(focusIdx, 1)[0] : undefined;
    const vocabTopic = slotFocus?.startsWith("vocab:") ? (slotFocus.slice(6) as Topic) : undefined;
    const topic = vocabTopic && (TOPICS as readonly string[]).includes(vocabTopic) ? vocabTopic : topics[slots.length % topics.length];
    slots.push({ ...chosen, level: levels[chosen.skill], topic, focus: slotFocus });
    const seconds = secondsFor(chosen.type);
    spent[chosen.skill] += seconds;
    remaining -= seconds;
    typeUses.set(chosen.type, (typeUses.get(chosen.type) ?? 0) + 1);
  }
  return slots;
}

export function planBlueprint(levels: Levels, targetMinutes: number, today: string): Blueprint {
  return { targetMinutes, slots: planSlots(levels, targetMinutes * 60 - RECAP_SECONDS, today, MIN_MAIN_ITEMS, targetMinutes) };
}

export function estimateSeconds(types: ExerciseType[]): number {
  return types.reduce((sum, t) => sum + secondsFor(t), 0);
}

// --- Fallback bank ----------------------------------------------------------

function recentlyUsedIds(days: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT si.exercise_id AS id FROM session_items si JOIN sessions s ON s.id = si.session_id
       WHERE s.created_at >= ? AND s.status != 'discarded'`,
    )
    .all(new Date(Date.now() - days * 86_400_000).toISOString()) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function usageCounts(): Map<number, number> {
  const rows = db.prepare("SELECT exercise_id AS id, COUNT(*) AS n FROM attempts GROUP BY exercise_id").all() as {
    id: number;
    n: number;
  }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

// Best stored exercise for a slot: right skill and level (or one below),
// preferring the slot's weak point and topic and anything not seen lately.
export function pickFromBank(slot: Slot, exclude: Set<number>): ExerciseRow | undefined {
  const recent = recentlyUsedIds(21);
  const usage = usageCounts();
  const score = (ex: ExerciseRow) =>
    (ex.type === slot.type ? 4 : 0) +
    (slot.focus && ex.content.categories.includes(slot.focus) ? 3 : 0) +
    (ex.topic === slot.topic ? 1 : 0) +
    (ex.level === slot.level ? 1 : 0) -
    (recent.has(ex.id) ? 6 : 0) -
    0.5 * (usage.get(ex.id) ?? 0) +
    Math.random() * 0.5;
  const allowedTypes = slot.skill === "writing" && slot.type !== "write" ? ["translate"] : TYPES_BY_SKILL[slot.skill];
  const candidates = queryExercises(
    `source IN ('seed', 'claude') AND skill = ? AND level BETWEEN ? AND ? AND type IN (${allowedTypes.map(() => "?").join(",")})`,
    [slot.skill, Math.max(0, slot.level - 1), slot.level, ...allowedTypes],
  ).filter((ex) => !exclude.has(ex.id));
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0];
}

export function pickReviewExercise(key: string, maxLevel: number, exclude: Set<number>): ExerciseRow | undefined {
  // Objective, quick types only: a recap question should take seconds.
  const quick = ["mc", "fill", "order", "match"];
  const pool = queryExercises(
    `source IN ('seed', 'claude') AND level <= ? AND type IN ('mc','fill','order','match') AND categories_json LIKE ?`,
    [maxLevel, `%"${key}"%`],
  ).filter((ex) => !exclude.has(ex.id) && quick.includes(ex.type));
  return pool[Math.floor(Math.random() * pool.length)];
}
