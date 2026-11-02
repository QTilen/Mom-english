import { config } from "../config";

// All day-based logic (streaks, "yesterday", due dates) uses her local calendar
// day, not UTC — a session at 00:30 in Ljubljana belongs to that day.
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: config.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function localDate(at: Date = new Date()): string {
  return dayFormatter.format(at);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ISO week key like "2026-W45", used to count streak freezes per week.
export function isoWeek(date: string): string {
  const target = new Date(`${date}T12:00:00Z`);
  const dayNr = (target.getUTCDay() + 6) % 7; // Monday = 0
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // Thursday of this week
  const year = target.getUTCFullYear();
  const thursday = target.valueOf();
  const firstThursday = new Date(Date.UTC(year, 0, 1));
  if (firstThursday.getUTCDay() !== 4) {
    firstThursday.setUTCMonth(0, 1 + ((4 - firstThursday.getUTCDay() + 7) % 7));
  }
  const week = 1 + Math.round((thursday - firstThursday.valueOf()) / 604_800_000);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function localHour(at: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: config.timezone, hour: "2-digit", hour12: false }).format(at),
  );
}
