import { db, getSetting, setSetting } from "../db";
import { MAX_LEVEL } from "../levels";
import { localDate, localHour } from "../util/dates";
import { getLevels } from "../engine/levels";
import { readySessionExists } from "../engine/session";
import { enqueue } from "./queue";

const CHECK_EVERY_MS = 10 * 60_000;
// Below this many stored exercises per skill at a level, top the bank up.
const BANK_MIN_PER_SKILL = 6;
const NIGHTLY_HOUR = 3;

function bankIsThin(level: number): boolean {
  const rows = db
    .prepare("SELECT skill, COUNT(*) AS n FROM exercises WHERE source IN ('seed', 'claude') AND level = ? GROUP BY skill")
    .all(level) as { skill: string; n: number }[];
  const counts = new Map(rows.map((r) => [r.skill, r.n]));
  return ["vocabulary", "grammar", "reading", "writing"].some((s) => (counts.get(s) ?? 0) < BANK_MIN_PER_SKILL);
}

export function checkNow(): void {
  if (getSetting("placement_done") !== "1") return;
  // Safety net: something should always be prepared for her next visit.
  if (!readySessionExists()) enqueue("generate_session", { reason: "safety" });

  const today = localDate();
  if (localHour() >= NIGHTLY_HOUR && getSetting("last_nightly") !== today) {
    setSetting("last_nightly", today);
    const levels = Object.values(getLevels());
    const lo = Math.max(0, Math.min(...levels) - 1);
    const hi = Math.min(MAX_LEVEL, Math.max(...levels) + 1);
    // At most two refills a night, to go easy on the subscription.
    let queued = 0;
    for (let level = lo; level <= hi && queued < 2; level++) {
      if (bankIsThin(level)) {
        enqueue("refill_bank", { level });
        queued++;
      }
    }
  }
}

export function startScheduler(): void {
  setTimeout(checkNow, 5_000);
  setInterval(checkNow, CHECK_EVERY_MS);
}
