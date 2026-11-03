import "../test-env-smart";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, setSetting } from "../db";
import { loadSeeds } from "../content/store";
import { setLevel } from "../engine/levels";
import { answerItem, completeSession, todayState } from "../engine/session";
import { registerJobs } from "./handlers";
import { enqueue, runNextJob } from "./queue";
import { addImage, getImage } from "../content/images";
import fs from "fs";
import os from "os";
import path from "path";

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

test("an uploaded screenshot becomes a picture lesson in the next session", async () => {
  process.env.IMAGES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  const id = addImage(png, ".png", "Zalando");
  await drainJobs();
  const img = getImage(id)!;
  assert.equal(img.status, "ready");
  const [pictureId] = JSON.parse(img.exercise_ids_json!);
  const ex = db.prepare("SELECT content_json FROM exercises WHERE id = ?").get(pictureId) as { content_json: string };
  assert.equal(JSON.parse(ex.content_json).title, "A dress on Zalando", "Claude was given the file to read");

  // Next session: the picture lesson is served first.
  db.prepare("UPDATE sessions SET status = 'discarded' WHERE status IN ('ready', 'in_progress')").run();
  db.exec("DELETE FROM days; UPDATE sessions SET local_date = '2000-01-01' WHERE status = 'completed'");
  const state = todayState();
  if (state.screen !== "session") throw new Error(`expected a session, got ${state.screen}`);
  const first = state.items.find((i) => i.phase === "main")!;
  assert.equal((first.view as any).type, "picture");
  assert.match((first.view as any).image, /^\/images\//);
});
