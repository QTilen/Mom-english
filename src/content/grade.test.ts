import "../test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { grade, isTypo, normalize } from "./grade";
import { loadPlacementFile } from "./store";
import type { Exercise } from "./schema";

const base = { topic: "food", categories: ["grammar:articles"], explanation_sl: "x" } as const;

test("normalize expands contractions and drops punctuation", () => {
  assert.equal(normalize("I’m  happy!"), "i am happy");
  assert.equal(normalize("She doesn't."), "she does not");
});

test("typos only forgive spelling, not grammar", () => {
  assert.equal(isTypo("kitchn", "kitchen"), true);
  assert.equal(isTypo("a", "an"), false);
  assert.equal(isTypo("apple", "apples"), false);
});

test("fill accepts contractions and flags typos as almost", () => {
  const ex: Exercise = { ...base, type: "fill", sentence: "She ___ work.", accepted: ["does not"] };
  assert.equal(grade(ex, { text: "doesn't" }, "grammar").outcome, "correct");
  const typo: Exercise = { ...base, type: "fill", sentence: "I am in the ___.", accepted: ["kitchen"] };
  assert.equal(grade(typo, { text: "kitchn" }, "grammar").outcome, "almost");
  assert.equal(grade(typo, { text: "garden" }, "grammar").outcome, "incorrect");
});

test("vocabulary translation ignores leading to/a/an", () => {
  const ex: Exercise = { ...base, type: "translate", sl: "kuhati", accepted: ["cook"] };
  assert.equal(grade(ex, { text: "to cook" }, "vocabulary").outcome, "correct");
});

test("unmatched sentence translation waits for Claude", () => {
  const ex: Exercise = { ...base, type: "translate", sl: "Rada kuham.", accepted: ["I like cooking."] };
  assert.equal(grade(ex, { text: "I love to cook" }, "writing").outcome, "pending");
});

test("matching gives partial credit", () => {
  const ex: Exercise = { ...base, type: "match", pairs: [{ sl: "a", en: "x" }, { sl: "b", en: "y" }, { sl: "c", en: "z" }, { sl: "d", en: "w" }] };
  const r = grade(ex, { matches: ["x", "y", "w", "z"] }, "vocabulary");
  assert.equal(r.outcome, "partial");
  assert.equal(r.score, 0.5);
});

test("placement seed is valid and covers every level and skill", () => {
  const p = loadPlacementFile();
  for (const skill of ["vocabulary", "grammar", "reading"]) {
    for (let level = 0; level <= 5; level++) {
      assert.ok(p.items.filter((i) => i.skill === skill && i.level === level).length >= 3, `${skill} L${level}`);
    }
  }
  assert.equal(p.writing.length, 6);
});

test("seed bank is valid and every exercise passes the consistency checks", async () => {
  const { BankFileSchema } = await import("./store");
  const { exerciseProblems } = await import("./schema");
  const fs = await import("fs");
  const path = await import("path");
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "seed", "bank.json"), "utf8"));
  const bank = BankFileSchema.parse(raw);
  const problems = bank.exercises.flatMap((e, i) => exerciseProblems(e.exercise, `#${i}`));
  assert.deepEqual(problems, []);
  for (let level = 0; level <= 5; level++) {
    for (const skill of ["vocabulary", "grammar", "reading", "writing"]) {
      assert.ok(bank.exercises.some((e) => e.level === level && e.skill === skill), `${skill} L${level}`);
    }
  }
});
