// Grows the fallback bank with Claude and writes it back to seed/bank.json so
// it ships with the repo. Usage: npm run bank:generate -- [level ...]
// (levels 0–5; default all). Needs a logged-in Claude CLI.
import fs from "fs";
import path from "path";
import { ROOT_DIR } from "../config";
import { db } from "../db";
import { loadSeeds } from "../content/store";
import { refillBank } from "../jobs/handlers";

async function main() {
  loadSeeds();
  const levels = process.argv.slice(2).map(Number);
  for (const level of levels.length ? levels : [0, 1, 2, 3, 4, 5]) {
    try {
      const n = await refillBank(level);
      console.log(`Level ${level}: added ${n} exercises`);
    } catch (err) {
      console.error(`Level ${level} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  const rows = db
    .prepare("SELECT skill, level, content_json FROM exercises WHERE source IN ('seed', 'claude') ORDER BY level, skill, id")
    .all() as { skill: string; level: number; content_json: string }[];
  const out = { exercises: rows.map((r) => ({ skill: r.skill, level: r.level, exercise: JSON.parse(r.content_json) })) };
  fs.writeFileSync(path.join(ROOT_DIR, "seed", "bank.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(`Wrote ${rows.length} exercises to seed/bank.json — review them before committing.`);
}

main();
