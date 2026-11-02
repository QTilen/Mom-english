import { db, nowIso } from "../db";
import { addDays } from "../util/dates";

// Spaced repetition over weak points. A card is a mistake category
// ("grammar:articles") or a single word ("word:pharmacy"). A wrong answer puts
// it back in box 1 (due tomorrow); each right answer on a due card moves it up
// a box, and after the last box it is retired as learned.

const INTERVALS = [1, 2, 4, 7, 14, 30];

export function recordWrong(keys: string[], exerciseId: number, today: string): void {
  const stmt = db.prepare(
    `INSERT INTO review_cards (key, box, due_date, lapses, last_exercise_id, retired, updated_at)
     VALUES (?, 1, ?, 1, ?, 0, ?)
     ON CONFLICT(key) DO UPDATE SET box = 1, due_date = excluded.due_date, lapses = lapses + 1,
       last_exercise_id = excluded.last_exercise_id, retired = 0, updated_at = excluded.updated_at`,
  );
  for (const key of new Set(keys)) stmt.run(key, addDays(today, INTERVALS[0]), exerciseId, nowIso());
}

export function recordRight(keys: string[], today: string): void {
  for (const key of new Set(keys)) {
    const card = db.prepare("SELECT box, due_date FROM review_cards WHERE key = ? AND retired = 0").get(key) as
      | { box: number; due_date: string }
      | undefined;
    // Only a review that was actually due advances the card; getting the same
    // point right twice in one day shouldn't skip a box.
    if (!card || card.due_date > today) continue;
    const box = card.box + 1;
    if (box > INTERVALS.length) {
      db.prepare("UPDATE review_cards SET retired = 1, updated_at = ? WHERE key = ?").run(nowIso(), key);
    } else {
      db.prepare("UPDATE review_cards SET box = ?, due_date = ?, updated_at = ? WHERE key = ?").run(
        box,
        addDays(today, INTERVALS[box - 1]),
        nowIso(),
        key,
      );
    }
  }
}

export interface DueCard {
  key: string;
  box: number;
  lapses: number;
  last_exercise_id: number | null;
}

export function dueCards(today: string, limit = 10): DueCard[] {
  return db
    .prepare(
      "SELECT key, box, lapses, last_exercise_id FROM review_cards WHERE retired = 0 AND due_date <= ? ORDER BY due_date, lapses DESC LIMIT ?",
    )
    .all(today, limit) as DueCard[];
}

export function recordWords(words: { en: string; sl: string }[] | undefined, correct: boolean, today: string): void {
  for (const w of words ?? []) {
    const en = w.en.trim().toLowerCase();
    db.prepare("INSERT OR IGNORE INTO words (en, sl, first_seen) VALUES (?, ?, ?)").run(en, w.sl.trim(), today);
    if (correct) {
      db.prepare(
        `UPDATE words SET last_result = 1,
           correct_days = correct_days + (CASE WHEN last_correct_date IS ? THEN 0 ELSE 1 END),
           last_correct_date = ? WHERE en = ?`,
      ).run(today, today, en);
    } else {
      db.prepare("UPDATE words SET last_result = 0, wrong_count = wrong_count + 1 WHERE en = ?").run(en);
    }
  }
}

// A word counts as learned once she has got it right on two different days
// and didn't get it wrong the last time she saw it.
export function wordsLearnedCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM words WHERE correct_days >= 2 AND last_result = 1").get() as { n: number }).n;
}

export function wordKeys(words: { en: string }[] | undefined): string[] {
  return (words ?? []).map((w) => `word:${w.en.trim().toLowerCase()}`);
}
