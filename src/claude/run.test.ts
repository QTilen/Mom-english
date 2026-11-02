import { test } from "node:test";
import assert from "node:assert/strict";
import "../test-env";
import { z } from "zod";
import { callClaudeJson, ClaudeError, extractJson } from "./run";

const schema = z.object({ word: z.string() });

test("extractJson tolerates code fences", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test("parses a valid reply", async () => {
  process.env.FAKE_CLAUDE_REPLY = JSON.stringify('{"word":"apple"}');
  const out = await callClaudeJson({ purpose: "test", system: "s", prompt: "p", schema });
  assert.equal(out.word, "apple");
});

test("rejects invalid output after one retry", async () => {
  process.env.FAKE_CLAUDE_REPLY = JSON.stringify('{"nope":true}');
  await assert.rejects(
    callClaudeJson({ purpose: "test", system: "s", prompt: "p", schema }),
    (err: unknown) => err instanceof ClaudeError && err.kind === "invalid_output",
  );
});

test("classifies an expired login as auth", async () => {
  process.env.FAKE_CLAUDE_MODE = "auth";
  await assert.rejects(
    callClaudeJson({ purpose: "test", system: "s", prompt: "p", schema }),
    (err: unknown) => err instanceof ClaudeError && err.kind === "auth",
  );
  delete process.env.FAKE_CLAUDE_MODE;
});
