import "../test-env-smart";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, setSetting } from "../db";
import { loadSeeds } from "../content/store";
import { setLevel } from "../engine/levels";
import { answerItem, completeSession, todayState } from "../engine/session";
import { registerJobs } from "./handlers";
import { enqueue, runNextJob } from "./queue";

async function drainJobs() {
  while (await runNextJob()) {}
}

test("generated session is stored, served, graded and feeds the next recap", async () => {
  loadSeeds();
  registerJobs();
  for (const s of ["vocabulary", "grammar", "reading", "writing"] as const) setLevel(s, 2, "placement");
  setSetting("placement_done", "1");
  setSetting("target_minutes", 8);

  enqueue("generate_session", { reason: "test" });
  await drainJobs();
  const ready = db.prepare("SELECT id, generated_by FROM sessions WHERE status = 'ready'").get() as { id: number; generated_by: string };
  assert.equal(ready.generated_by, "claude");

  const state = todayState();
  assert.equal(state.screen, "session");
  if (state.screen !== "session") return;
  assert.ok(state.items.length >= 3);

  for (const item of state.items) {
    const v = item.view as any;
    const answer =
      v.type === "mc" ? { option: v.options[0] }
      : v.type === "fill" ? { text: "a" }
      : v.type === "order" ? { words: v.words }
      : v.type === "match" ? { matches: v.right }
      : v.type === "reading" ? { options: v.questions.map((q: any) => q.options[0]) }
      : { text: "I likes coffee very much" };
    answerItem(state.session.id, item.id, answer as never, 5000);
  }
  const summary = completeSession(state.session.id);
  assert.ok(summary.total > 0);

  // Grading jobs for free text, then tomorrow's generation.
  await drainJobs();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM writing_reviews WHERE status = 'pending'").get() as { n: number };
  assert.equal(pending.n, 0);
  const next = db.prepare("SELECT recap_json FROM sessions WHERE status = 'ready'").get() as { recap_json: string };
  assert.ok(JSON.parse(next.recap_json).length > 0, "next session carries a recap");
});
