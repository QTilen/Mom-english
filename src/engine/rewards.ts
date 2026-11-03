import { db, getSetting, setSetting } from "../db";

// Things to collect: 🔥 one per practice day, ⭐ 1–3 per session, badges for
// milestones, and real rewards (set by the family in admin) at streak milestones.

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

// Slovenian singular / dual / plural: 1 dan, 2 dneva, 3 dnevi, 5 dni.
function plural(n: number, one: string, two: string, few: string, many: string): string {
  const m = n % 100;
  return m === 1 ? one : m === 2 ? two : m === 3 || m === 4 ? few : many;
}

function remainingText(kind: Badge["kind"], n: number): string {
  if (kind === "streak") return `še ${n} ${plural(n, "dan", "dneva", "dnevi", "dni")}`;
  if (kind === "words") return `še ${n} ${plural(n, "beseda", "besedi", "besede", "besed")}`;
  return `še ${n} ⭐`;
}

export function badgeStates(stats: CollectionStats) {
  const value = (b: Badge) => (b.kind === "streak" ? stats.bestStreak : b.kind === "words" ? stats.wordsLearned : stats.totalStars);
  return BADGES.map((b) => {
    const remaining = Math.max(0, b.threshold - value(b));
    return {
      id: b.id,
      icon: b.icon,
      title_sl: b.title_sl,
      desc_sl: b.desc_sl,
      earned: remaining === 0,
      remaining,
      remaining_sl: remainingText(b.kind, remaining),
    };
  });
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

// Streak milestones that unlock a family reward, each once: two weeks, then
// one, two, six and twelve months, then every further year.
export const REWARD_MILESTONES = [14, 30, 60, 180, 365];

const MILESTONE_LABELS_SL: Record<number, string> = {
  14: "2 tedna",
  30: "1 mesec",
  60: "2 meseca",
  180: "6 mesecev",
  365: "1 leto",
};

function milestoneLabel(days: number): string {
  return MILESTONE_LABELS_SL[days] ?? `${Math.round(days / 365)} let`;
}

function isMilestone(days: number): boolean {
  return REWARD_MILESTONES.includes(days) || (days > 365 && days % 365 === 0);
}

// The reward text for each milestone, set by the family in admin.
export function rewardPlan(): { days: number; label_sl: string; text: string }[] {
  const texts = JSON.parse(getSetting("reward_plan") ?? "{}") as Record<string, string>;
  return REWARD_MILESTONES.map((days) => ({ days, label_sl: milestoneLabel(days), text: texts[days] || DEFAULT_REWARD_TEXT }));
}

export function setRewardText(days: number, text: string): void {
  const texts = JSON.parse(getSetting("reward_plan") ?? "{}") as Record<string, string>;
  texts[days] = text;
  setSetting("reward_plan", JSON.stringify(texts));
}

function rewardTextFor(days: number): string {
  return rewardPlan().find((p) => p.days === days)?.text ?? rewardPlan().at(-1)!.text;
}

function unlockedMilestones(): Set<number> {
  return new Set((db.prepare("SELECT streak FROM rewards").all() as { streak: number }[]).map((r) => r.streak));
}

// The next milestone she hasn't unlocked yet, and how far along the streak is.
export function rewardProgress(streak: number) {
  const done = unlockedMilestones();
  let target = REWARD_MILESTONES.find((m) => !done.has(m));
  if (target === undefined) {
    target = 730;
    while (done.has(target)) target += 365;
  }
  const current = Math.min(streak, target);
  return { every: target, label_sl: milestoneLabel(target), current, daysLeft: target - current };
}

// Called once a day when she completes practice. Each milestone pays out once,
// so after a broken streak she works towards the next reward, not the same one.
export function maybeUnlockReward(today: string, streak: number) {
  if (!isMilestone(streak) || unlockedMilestones().has(streak)) return undefined;
  db.prepare("INSERT OR IGNORE INTO rewards (unlocked_on, streak, reward_text) VALUES (?, ?, ?)").run(today, streak, rewardTextFor(streak));
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
