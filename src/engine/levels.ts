import { db, nowIso } from "../db";
import { SKILLS, clampLevel, type Skill } from "../levels";

export type Levels = Record<Skill, number>;

export function getLevels(): Levels {
  const rows = db.prepare("SELECT skill, level FROM skill_levels").all() as { skill: Skill; level: number }[];
  const levels = Object.fromEntries(SKILLS.map((s) => [s, 1])) as Levels;
  for (const r of rows) levels[r.skill] = r.level;
  return levels;
}

export function setLevel(skill: Skill, level: number, reason: string): void {
  const to = clampLevel(level);
  const current = db.prepare("SELECT level FROM skill_levels WHERE skill = ?").get(skill) as { level: number } | undefined;
  if (current && current.level === to && reason !== "placement") return;
  db.prepare(
    "INSERT INTO skill_levels (skill, level, updated_at) VALUES (?, ?, ?) ON CONFLICT(skill) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at",
  ).run(skill, to, nowIso());
  db.prepare("INSERT INTO level_history (skill, from_level, to_level, reason, created_at) VALUES (?, ?, ?, ?, ?)").run(
    skill,
    current?.level ?? null,
    to,
    reason,
    nowIso(),
  );
}

// When a skill's level last changed for any reason; the adaptation window
// only looks at sessions after this, so each change starts a fresh window.
export function levelChangedAt(skill: Skill): string {
  const row = db.prepare("SELECT MAX(created_at) AS at FROM level_history WHERE skill = ?").get(skill) as { at: string | null };
  return row.at ?? "1970-01-01T00:00:00.000Z";
}
