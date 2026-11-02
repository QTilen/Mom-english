export const SKILLS = ["vocabulary", "grammar", "reading", "writing"] as const;
export type Skill = (typeof SKILLS)[number];

// Placement tops out at A2.2; B1 is reached through months of practice.
export const LEVELS = ["Pre-A1", "A1.1", "A1.2", "A1.3", "A2.1", "A2.2", "B1.1", "B1.2"] as const;
export const MAX_LEVEL = LEVELS.length - 1;

export const SKILL_LABELS_SL: Record<Skill, string> = {
  vocabulary: "Besedišče",
  grammar: "Slovnica",
  reading: "Branje",
  writing: "Pisanje",
};

export function levelLabel(level: number): string {
  return LEVELS[clampLevel(level)];
}

export function clampLevel(level: number): number {
  return Math.max(0, Math.min(MAX_LEVEL, Math.round(level)));
}

export function parseLevelLabel(label: string): number | undefined {
  const idx = LEVELS.findIndex((l) => l.toLowerCase() === label.trim().toLowerCase());
  return idx === -1 ? undefined : idx;
}
