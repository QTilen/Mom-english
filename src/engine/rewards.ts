import { db, getNumberSetting, getSetting, setSetting } from "../db";

// Things to collect: 🔥 one per practice day, ⭐ 1–3 per session, badges for
// milestones, and a real reward (set by the family in admin) every N-day streak.

export const DEFAULT_REWARD_EVERY = 14;
export const DEFAULT_REWARD_TEXT = "Presenečenje od družine 🎁";

export function starsFor(correct: number, total: number): number {
  if (total === 0) return 1;
  const ratio = correct / total;
  return 1 + (ratio >= 0.7 ? 1 : 0) + (ratio >= 0.9 ? 1 : 0);
}

interface Badge {
  id: string;
  icon: string;
  title_sl: string;
  desc_sl: string;
  kind: "streak" | "words" | "stars";
  threshold: number;
}

export const BADGES: Badge[] = [
  { id: "streak3", icon: "🌱", title_sl: "Kalček", desc_sl: "3 dni zapored", kind: "streak", threshold: 3 },
  { id: "streak7", icon: "🌷", title_sl: "Prvi teden", desc_sl: "7 dni zapored", kind: "streak", threshold: 7 },
  { id: "streak14", icon: "🏅", title_sl: "Dva tedna", desc_sl: "14 dni zapored", kind: "streak", threshold: 14 },
  { id: "streak30", icon: "🌟", title_sl: "Cel mesec", desc_sl: "30 dni zapored", kind: "streak", threshold: 30 },
  { id: "streak60", icon: "🏆", title_sl: "Prava vztrajnost", desc_sl: "60 dni zapored", kind: "streak", threshold: 60 },
  { id: "streak100", icon: "👑", title_sl: "Kraljica angleščine", desc_sl: "100 dni zapored", kind: "streak", threshold: 100 },
  { id: "words10", icon: "📖", title_sl: "Prvih 10 besed", desc_sl: "10 naučenih besed", kind: "words", threshold: 10 },
  { id: "words50", icon: "📚", title_sl: "Knjižni molj", desc_sl: "50 naučenih besed", kind: "words", threshold: 50 },
  { id: "words100", icon: "🎓", title_sl: "Sto besed", desc_sl: "100 naučenih besed", kind: "words", threshold: 100 },
  { id: "stars25", icon: "⭐", title_sl: "Zvezdica", desc_sl: "25 zvezdic", kind: "stars", threshold: 25 },
  { id: "stars100", icon: "✨", title_sl: "Zvezdnato nebo", desc_sl: "100 zvezdic", kind: "stars", threshold: 100 },
];

export interface CollectionStats {
  bestStreak: number;
  wordsLearned: number;
  totalStars: number;
}

export function badgeStates(stats: CollectionStats) {
  const value = (b: Badge) => (b.kind === "streak" ? stats.bestStreak : b.kind === "words" ? stats.wordsLearned : stats.totalStars);
  return BADGES.map((b) => ({
    id: b.id,
    icon: b.icon,
    title_sl: b.title_sl,
    desc_sl: b.desc_sl,
    earned: value(b) >= b.threshold,
    remaining: Math.max(0, b.threshold - value(b)),
  }));
}

// Badges earned since we last celebrated any. Remembering what was already
// shown (rather than diffing before/after) also catches badges earned between
// sessions, e.g. words that count as learned once Claude grades a translation.
export function takeNewBadges(stats: CollectionStats) {
  const announced = new Set<string>(JSON.parse(getSetting("announced_badges") ?? "[]"));
  const earned = badgeStates(stats).filter((b) => b.earned);
  const fresh = earned.filter((b) => !announced.has(b.id));
  if (fresh.length) setSetting("announced_badges", JSON.stringify(earned.map((b) => b.id)));
  return fresh;
}

export function totalStars(): number {
  return (db.prepare("SELECT COALESCE(SUM(stars), 0) AS n FROM sessions WHERE status = 'completed'").get() as { n: number }).n;
}

export function practiceDays(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM days WHERE status = 'completed'").get() as { n: number }).n;
}

export function rewardSettings() {
  return {
    rewardEveryDays: getNumberSetting("reward_every_days", DEFAULT_REWARD_EVERY),
    rewardText: getSetting("reward_text") ?? DEFAULT_REWARD_TEXT,
  };
}

export function rewardProgress(streak: number) {
  const every = rewardSettings().rewardEveryDays;
  const into = streak > 0 && streak % every === 0 ? every : streak % every;
  return { every, current: into, daysLeft: every - into };
}

// Called once a day when she completes practice: hitting a multiple of the
// reward interval unlocks the reward the family has set.
export function maybeUnlockReward(today: string, streak: number) {
  const { rewardEveryDays, rewardText } = rewardSettings();
  if (streak === 0 || streak % rewardEveryDays !== 0) return undefined;
  db.prepare("INSERT OR IGNORE INTO rewards (unlocked_on, streak, reward_text) VALUES (?, ?, ?)").run(today, streak, rewardText);
  return db.prepare("SELECT id, unlocked_on, streak, reward_text, given_at FROM rewards WHERE unlocked_on = ?").get(today) as {
    id: number;
    unlocked_on: string;
    streak: number;
    reward_text: string;
    given_at: string | null;
  };
}

export function rewardsList() {
  return db.prepare("SELECT id, unlocked_on, streak, reward_text, given_at FROM rewards ORDER BY id DESC").all() as {
    id: number;
    unlocked_on: string;
    streak: number;
    reward_text: string;
    given_at: string | null;
  }[];
}
