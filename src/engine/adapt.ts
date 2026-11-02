import { db } from "../db";
import { MAX_LEVEL, SKILLS, type Skill } from "../levels";
import { getLevels, levelChangedAt, setLevel } from "./levels";

// Moves each skill up after sustained success (>85% over her last three
// sessions with that skill) and down after a rough patch (<50% over two).
// Only sessions since the skill's last level change count, so a change always
// starts a fresh window. Safe to call repeatedly (e.g. again after Claude
// finishes grading writing from an earlier session).

const UP_SESSIONS = 3;
const UP_MIN_ITEMS = 5;
const UP_THRESHOLD = 0.85;
const DOWN_SESSIONS = 2;
const DOWN_MIN_ITEMS = 4;
const DOWN_THRESHOLD = 0.5;

export interface LevelChange {
  skill: Skill;
  from: number;
  to: number;
}

function sessionScores(skill: Skill, since: string): number[][] {
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, COALESCE(a.score, a.correct) AS score
       FROM attempts a
       JOIN session_items si ON si.id = a.session_item_id
       JOIN sessions s ON s.id = si.session_id
       WHERE s.status = 'completed' AND s.completed_at > ? AND si.phase = 'main'
         AND a.skill = ? AND a.correct IS NOT NULL
       ORDER BY s.completed_at DESC`,
    )
    .all(since, skill) as { session_id: number; score: number }[];
  const bySession = new Map<number, number[]>();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id)!.push(r.score);
  }
  return [...bySession.values()]; // newest session first
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function decideChange(sessions: number[][]): -1 | 0 | 1 {
  if (sessions.length >= UP_SESSIONS) {
    const pooled = sessions.slice(0, UP_SESSIONS).flat();
    if (pooled.length >= UP_MIN_ITEMS && mean(pooled) > UP_THRESHOLD) return 1;
  }
  if (sessions.length >= DOWN_SESSIONS) {
    const pooled = sessions.slice(0, DOWN_SESSIONS).flat();
    if (pooled.length >= DOWN_MIN_ITEMS && mean(pooled) < DOWN_THRESHOLD) return -1;
  }
  return 0;
}

export function adaptLevels(): LevelChange[] {
  const levels = getLevels();
  const changes: LevelChange[] = [];
  for (const skill of SKILLS) {
    const step = decideChange(sessionScores(skill, levelChangedAt(skill)));
    const to = Math.max(0, Math.min(MAX_LEVEL, levels[skill] + step));
    if (to !== levels[skill]) {
      setLevel(skill, to, step > 0 ? "auto_up" : "auto_down");
      changes.push({ skill, from: levels[skill], to });
    }
  }
  return changes;
}
