import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "./config";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Current sub-level per skill (0 = Pre-A1 … 5 = A2.2). One row per skill.
  CREATE TABLE IF NOT EXISTS skill_levels (
    skill TEXT PRIMARY KEY,
    level INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS level_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill TEXT NOT NULL,
    from_level INTEGER,
    to_level INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Every exercise she can be served: hand-written seed, placement items and
  -- everything Claude ever generated. This doubles as the offline fallback bank.
  CREATE TABLE IF NOT EXISTS exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    skill TEXT NOT NULL,
    level INTEGER NOT NULL,
    topic TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    content_json TEXT NOT NULL,
    source TEXT NOT NULL,            -- seed | claude | placement
    content_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS exercises_pick ON exercises (source, skill, level, type);

  CREATE TABLE IF NOT EXISTS placement_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    state_json TEXT NOT NULL,
    result_json TEXT
  );

  -- Free writing answers awaiting or holding Claude's feedback, for both the
  -- placement test (placement_attempt_id) and daily sessions (attempt_id).
  CREATE TABLE IF NOT EXISTS writing_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,              -- write | translate
    attempt_id INTEGER,
    placement_attempt_id INTEGER,
    prompt_json TEXT NOT NULL,
    text TEXT NOT NULL,
    level INTEGER NOT NULL,
    status TEXT NOT NULL,            -- pending | graded | failed
    result_json TEXT,
    seen INTEGER NOT NULL DEFAULT 0, -- shown to her in a recap yet?
    created_at TEXT NOT NULL,
    graded_at TEXT
  );

  -- One row per daily session. A session is prepared ahead of time (ready) and
  -- served the next time she opens the app, so planned_for is advisory only.
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,            -- ready | in_progress | completed | discarded
    generated_by TEXT NOT NULL,      -- claude | bank
    target_minutes INTEGER NOT NULL,
    blueprint_json TEXT NOT NULL,
    recap_json TEXT,
    summary_json TEXT,
    local_date TEXT,                 -- day she actually did it (Europe/Ljubljana)
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS session_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    position INTEGER NOT NULL,
    phase TEXT NOT NULL,             -- recap | main
    kind TEXT NOT NULL,              -- new | review
    exercise_id INTEGER NOT NULL REFERENCES exercises(id)
  );
  CREATE INDEX IF NOT EXISTS session_items_session ON session_items (session_id, position);

  -- correct is NULL while a free-text answer is still waiting for Claude.
  -- score is 0..1 (partial credit for matching/reading, Claude score for writing).
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_item_id INTEGER UNIQUE REFERENCES session_items(id),
    exercise_id INTEGER NOT NULL REFERENCES exercises(id),
    skill TEXT NOT NULL,
    type TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    correct INTEGER,
    score REAL,
    feedback_json TEXT NOT NULL,
    ms INTEGER,
    local_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mistakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER REFERENCES attempts(id),
    category TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mistakes_category ON mistakes (category, created_at);

  -- Leitner-style spaced repetition, one card per weak point (a category or a word).
  CREATE TABLE IF NOT EXISTS review_cards (
    key TEXT PRIMARY KEY,
    box INTEGER NOT NULL,
    due_date TEXT NOT NULL,
    lapses INTEGER NOT NULL DEFAULT 0,
    last_exercise_id INTEGER,
    retired INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS words (
    en TEXT PRIMARY KEY,
    sl TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_correct_date TEXT,
    correct_days INTEGER NOT NULL DEFAULT 0,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    last_result INTEGER
  );

  -- Streak bookkeeping, one row per local calendar day once she has started.
  CREATE TABLE IF NOT EXISTS days (
    date TEXT PRIMARY KEY,
    status TEXT NOT NULL             -- completed | frozen | missed
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,            -- queued | running | done | failed
    tries INTEGER NOT NULL DEFAULT 0,
    run_after TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS jobs_next ON jobs (status, run_after);

  CREATE TABLE IF NOT EXISTS claude_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purpose TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ms INTEGER,
    ok INTEGER NOT NULL,
    error_kind TEXT,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_tokens (
    token TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );

  -- Real-world rewards (agreed by the family) unlocked by long streaks.
  CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unlocked_on TEXT NOT NULL UNIQUE,
    streak INTEGER NOT NULL,
    reward_text TEXT NOT NULL,
    given_at TEXT
  );
`);

// Columns added after the first release; ALTER only when missing.
function addColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("sessions", "stars", "INTEGER");

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string | number): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

export function getNumberSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  return raw === undefined ? fallback : Number(raw);
}
