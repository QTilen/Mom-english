import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { ROOT_DIR } from "../config";
import { db, nowIso } from "../db";
import { SKILLS, type Skill } from "../levels";
import { DEFAULT_INSTRUCTIONS_SL, Exercise, ExerciseSchema, exerciseProblems } from "./schema";

export interface ExerciseRow {
  id: number;
  type: Exercise["type"];
  skill: Skill;
  level: number;
  topic: string;
  source: string;
  content: Exercise;
}

interface RawRow {
  id: number;
  type: Exercise["type"];
  skill: Skill;
  level: number;
  topic: string;
  source: string;
  content_json: string;
}

function hydrate(row: RawRow): ExerciseRow {
  const { content_json, ...rest } = row;
  return { ...rest, content: JSON.parse(content_json) };
}

function hashContent(ex: Exercise): string {
  return crypto.createHash("sha256").update(JSON.stringify(ex)).digest("hex").slice(0, 32);
}

// Inserts an exercise, or returns the existing id if identical content is
// already stored (Claude occasionally repeats itself; seeds load every boot).
export function saveExercise(ex: Exercise, skill: Skill, level: number, source: string): number {
  const hash = hashContent(ex);
  const existing = db.prepare("SELECT id FROM exercises WHERE content_hash = ?").get(hash) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO exercises (type, skill, level, topic, categories_json, content_json, source, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ex.type, skill, level, ex.topic, JSON.stringify(ex.categories), JSON.stringify(ex), source, hash, nowIso());
  return Number(info.lastInsertRowid);
}

export function getExercise(id: number): ExerciseRow {
  const row = db.prepare("SELECT * FROM exercises WHERE id = ?").get(id) as RawRow | undefined;
  if (!row) throw new Error(`exercise ${id} not found`);
  return hydrate(row);
}

export function queryExercises(where: string, params: unknown[]): ExerciseRow[] {
  return (db.prepare(`SELECT * FROM exercises WHERE ${where}`).all(...params) as RawRow[]).map(hydrate);
}

// --- Seed files -------------------------------------------------------------

const SkillSchema = z.enum(SKILLS);
const LevelSchema = z.number().int().min(0).max(5);

export const PlacementFileSchema = z.object({
  items: z.array(z.object({ id: z.string(), skill: SkillSchema, level: LevelSchema, exercise: ExerciseSchema })),
  writing: z.array(z.object({ level: LevelSchema, exercise: ExerciseSchema })),
});
export type PlacementFile = z.infer<typeof PlacementFileSchema>;

export const BankFileSchema = z.object({
  exercises: z.array(z.object({ skill: SkillSchema, level: LevelSchema, exercise: ExerciseSchema })),
});

function readSeed<T>(file: string, schema: z.ZodType<T>): T | undefined {
  const full = path.join(ROOT_DIR, "seed", file);
  if (!fs.existsSync(full)) return undefined;
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(full, "utf8")));
  if (!parsed.success) {
    throw new Error(`seed/${file} is invalid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

let placementCache: PlacementFile | undefined;

export function loadPlacementFile(): PlacementFile {
  if (!placementCache) {
    const data = readSeed("placement.json", PlacementFileSchema);
    if (!data) throw new Error("seed/placement.json is missing");
    const problems = data.items.flatMap((i) => exerciseProblems(i.exercise, i.id));
    if (problems.length) throw new Error(`seed/placement.json: ${problems.join("; ")}`);
    placementCache = data;
  }
  return placementCache;
}

export function loadSeeds(): { bank: number } {
  loadPlacementFile();
  const bank = readSeed("bank.json", BankFileSchema);
  let count = 0;
  if (bank) {
    const insertAll = db.transaction(() => {
      for (const item of bank.exercises) {
        if (exerciseProblems(item.exercise).length) continue;
        saveExercise(item.exercise, item.skill, item.level, "seed");
        count++;
      }
    });
    insertAll();
  }
  return { bank: count };
}

// --- What the browser gets ----------------------------------------------------

// Deterministic so reloading the page shows the same order.
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed % 2147483647 || 1;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Never send answers to the browser; this is what the exercise player renders.
export function publicView(ex: Exercise, seed: number): Record<string, unknown> {
  const base = { type: ex.type, instruction_sl: DEFAULT_INSTRUCTIONS_SL[ex.type] };
  switch (ex.type) {
    case "mc":
      return { ...base, instruction_sl: ex.prompt_sl ?? base.instruction_sl, question: ex.question, options: seededShuffle(ex.options, seed) };
    case "fill":
      return { ...base, sentence: ex.sentence, options: ex.options ? seededShuffle(ex.options, seed) : undefined, hint_sl: ex.hint_sl };
    case "order": {
      let words = seededShuffle(ex.tokens, seed);
      // Make sure the shuffle didn't land on the answer.
      for (let k = 1; words.join(" ") === ex.tokens.join(" ") && k < 5; k++) words = seededShuffle(ex.tokens, seed + k);
      return { ...base, words, sl: ex.sl };
    }
    case "match":
      return { ...base, left: ex.pairs.map((p) => p.sl), right: seededShuffle(ex.pairs.map((p) => p.en), seed) };
    case "reading":
      return {
        ...base,
        title: ex.title,
        text: ex.text,
        questions: ex.questions.map((q, i) => ({ question: q.question, options: seededShuffle(q.options, seed + i) })),
      };
    case "translate":
      return { ...base, sl: ex.sl };
    case "write":
      return { ...base, instruction_sl: ex.prompt_sl, prompt_en: ex.prompt_en, hint_sl: ex.hint_sl, min_words: ex.min_words, max_words: ex.max_words };
  }
}
