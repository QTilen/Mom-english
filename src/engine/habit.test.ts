import "../test-env";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, setSetting } from "../db";
import { addDays } from "../util/dates";
import { currentStreak, freezesLeft, ladder, markDayCompleted, maybeDropBack, maybeStepUp, settleDays, targetMinutes } from "./habit";
import { estimateLevel } from "./placement";

const MONDAY = "2026-11-02";

beforeEach(() => {
  db.exec("DELETE FROM days; DELETE FROM settings;");
  setSetting("target_minutes", 5);
  setSetting("target_changed_on", addDays(MONDAY, -1));
});

test("a missed day is bridged by a freeze, the third in a week is not", () => {
  markDayCompleted(MONDAY);
  // Away Tue, Wed, Thu; back on Friday.
  const friday = addDays(MONDAY, 4);
  settleDays(friday);
  assert.equal(freezesLeft(friday), 0);
  assert.equal(currentStreak(friday), 0);
  markDayCompleted(friday);
  assert.equal(currentStreak(friday), 1);
});

test("streak survives one frozen day", () => {
  markDayCompleted(MONDAY);
  const wed = addDays(MONDAY, 2);
  settleDays(wed);
  markDayCompleted(wed);
  assert.equal(currentStreak(wed), 2);
});

test("seven sessions in eight days step the session up", () => {
  for (let i = 0; i < 6; i++) markDayCompleted(addDays(MONDAY, i));
  assert.equal(maybeStepUp(addDays(MONDAY, 5)), undefined);
  markDayCompleted(addDays(MONDAY, 6));
  assert.deepEqual(maybeStepUp(addDays(MONDAY, 6)), { from: 5, to: 7 });
  assert.equal(targetMinutes(), 7);
});

test("three days away drops back one step, only once", () => {
  setSetting("target_minutes", 22);
  markDayCompleted(MONDAY);
  const back = addDays(MONDAY, 4);
  assert.deepEqual(maybeDropBack(back), { from: 22, to: 18 });
  assert.equal(maybeDropBack(back), undefined);
});

test("placement estimate is conservative", () => {
  const all = [1, 2, 3, 4, 5, 5, 5, 5].map((level) => ({ level, correct: true }));
  assert.equal(estimateLevel(all), 5);
  const climbing = [1, 2, 3, 4, 5].map((level) => ({ level, correct: true }));
  assert.equal(estimateLevel(climbing), 3);
  const wobble = [
    { level: 1, correct: true },
    { level: 2, correct: true },
    { level: 3, correct: false },
    { level: 2, correct: true },
    { level: 3, correct: false },
  ];
  assert.equal(estimateLevel(wobble), 2);
  assert.equal(estimateLevel([1, 0, 0, 0, 0].map((level) => ({ level, correct: false }))), 0);
});

test("the ladder reaches 45 minutes in twelve weekly steps", () => {
  const rungs = ladder(45);
  assert.equal(rungs[0], 5);
  assert.equal(rungs.at(-1), 45);
  assert.equal(rungs.length - 1, 12);
  assert.deepEqual(ladder(20), [5, 7, 9, 12, 15, 18, 20]);
});
