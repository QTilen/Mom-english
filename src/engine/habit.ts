import { db, getNumberSetting, getSetting, setSetting } from "../db";
import { addDays, daysBetween, isoWeek } from "../util/dates";

// Atomic-habits style load management: start tiny so showing up is easy,
// grow one rung only after a week of consistency, step back one rung after a
// real break. Streak freezes bridge the occasional missed day.

export const START_MINUTES = 5;
const STEP_UP_SESSIONS = 7;
const STEP_UP_WINDOW_DAYS = 8;
const DROP_BACK_AFTER_DAYS_AWAY = 3;
export const DEFAULT_CAP_MINUTES = 45;

// Eight weekly rungs: 30 minutes after about a month of steady practice and
// 45 after about two. Steps grow as the habit takes hold, then level off.
const BASE_LADDER = [5, 9, 14, 21, 30, 34, 38, 42, 45];

export function ladder(cap: number): number[] {
  const rungs = BASE_LADDER.filter((m) => m <= cap);
  while (rungs[rungs.length - 1] < cap) rungs.push(Math.min(cap, rungs[rungs.length - 1] + 4));
  return rungs;
}

export function habitSettings() {
  const capMinutes = getNumberSetting("cap_minutes", DEFAULT_CAP_MINUTES);
  return {
    capMinutes,
    freezesPerWeek: getNumberSetting("freezes_per_week", 2),
    ladder: ladder(capMinutes),
  };
}

function nextRung(current: number, cap: number): number {
  return ladder(cap).find((m) => m > current) ?? cap;
}

function previousRung(current: number, cap: number): number {
  return [...ladder(cap)].reverse().find((m) => m < current) ?? START_MINUTES;
}

export function targetMinutes(): number {
  return Math.min(getNumberSetting("target_minutes", START_MINUTES), habitSettings().capMinutes);
}

function setTarget(minutes: number, today: string): void {
  setSetting("target_minutes", minutes);
  setSetting("target_changed_on", today);
}

export function markDayCompleted(date: string): void {
  db.prepare("INSERT INTO days (date, status) VALUES (?, 'completed') ON CONFLICT(date) DO UPDATE SET status = 'completed'").run(date);
}

function freezesUsedInWeek(date: string): number {
  const week = isoWeek(date);
  const frozen = db.prepare("SELECT date FROM days WHERE status = 'frozen'").all() as { date: string }[];
  return frozen.filter((d) => isoWeek(d.date) === week).length;
}

// Fills in every past day she didn't practise, spending a freeze if the
// week still has one. Runs whenever she opens the app.
export function settleDays(today: string): void {
  const last = db.prepare("SELECT MAX(date) AS d FROM days").get() as { d: string | null };
  if (!last.d) return;
  const { freezesPerWeek } = habitSettings();
  for (let d = addDays(last.d, 1); d < today; d = addDays(d, 1)) {
    const status = freezesUsedInWeek(d) < freezesPerWeek ? "frozen" : "missed";
    db.prepare("INSERT OR IGNORE INTO days (date, status) VALUES (?, ?)").run(d, status);
  }
}

export function currentStreak(today: string): number {
  const rows = db.prepare("SELECT date, status FROM days WHERE date <= ? ORDER BY date DESC").all(today) as {
    date: string;
    status: string;
  }[];
  const byDate = new Map(rows.map((r) => [r.date, r.status]));
  let streak = 0;
  // Today only counts once it's done; not having practised yet today doesn't break anything.
  let d = byDate.get(today) === "completed" ? today : addDays(today, -1);
  for (;;) {
    const status = byDate.get(d);
    if (status === "completed") streak++;
    else if (status !== "frozen") break;
    d = addDays(d, -1);
  }
  return streak;
}

export function bestStreak(): number {
  const rows = db.prepare("SELECT date, status FROM days ORDER BY date").all() as { date: string; status: string }[];
  let best = 0;
  let run = 0;
  let prev: string | undefined;
  for (const r of rows) {
    if (prev && daysBetween(prev, r.date) !== 1) run = 0;
    if (r.status === "completed") run++;
    else if (r.status === "missed") run = 0;
    best = Math.max(best, run);
    prev = r.date;
  }
  return best;
}

export function freezesLeft(today: string): number {
  return Math.max(0, habitSettings().freezesPerWeek - freezesUsedInWeek(today));
}

export interface TargetChange {
  from: number;
  to: number;
}

// After finishing a session: a week of consistency since the last change earns
// a slightly longer session.
export function maybeStepUp(today: string): TargetChange | undefined {
  const { capMinutes } = habitSettings();
  const current = targetMinutes();
  if (current >= capMinutes) return undefined;
  const changedOn = getSetting("target_changed_on") ?? "1970-01-01";
  const since = addDays(today, -(STEP_UP_WINDOW_DAYS - 1));
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM days WHERE status = 'completed' AND date >= ? AND date <= ? AND date > ?")
    .get(since, today, changedOn) as { n: number };
  if (row.n < STEP_UP_SESSIONS) return undefined;
  const to = nextRung(current, capMinutes);
  setTarget(to, today);
  return { from: current, to };
}

// When she comes back after several days away: one step easier, once per break.
export function maybeDropBack(today: string): TargetChange | undefined {
  const { capMinutes } = habitSettings();
  const current = targetMinutes();
  if (current <= START_MINUTES) return undefined;
  const last = db.prepare("SELECT MAX(date) AS d FROM days WHERE status = 'completed' AND date < ?").get(today) as {
    d: string | null;
  };
  if (!last.d) return undefined;
  const daysAway = daysBetween(last.d, today) - 1;
  const changedOn = getSetting("target_changed_on") ?? "1970-01-01";
  if (daysAway < DROP_BACK_AFTER_DAYS_AWAY || changedOn > last.d) return undefined;
  const to = previousRung(current, capMinutes);
  setTarget(to, today);
  return { from: current, to };
}

export function setTargetManually(minutes: number, today: string): void {
  setTarget(Math.max(START_MINUTES, Math.min(minutes, habitSettings().capMinutes)), today);
}
