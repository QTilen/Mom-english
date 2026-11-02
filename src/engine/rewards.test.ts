import "../test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setSetting } from "../db";
import { maybeUnlockReward, rewardProgress, starsFor, takeNewBadges } from "./rewards";

test("stars reward effort first, accuracy second", () => {
  assert.equal(starsFor(2, 8), 1);
  assert.equal(starsFor(6, 8), 2);
  assert.equal(starsFor(8, 8), 3);
});

test("reward unlocks on every 14th streak day, once per day", () => {
  setSetting("reward_text", "Kosilo v restavraciji");
  assert.equal(maybeUnlockReward("2026-11-10", 13), undefined);
  const r = maybeUnlockReward("2026-11-11", 14);
  assert.equal(r?.reward_text, "Kosilo v restavraciji");
  assert.equal(maybeUnlockReward("2026-11-11", 14)?.id, r?.id);
  assert.deepEqual(rewardProgress(14), { every: 14, current: 14, daysLeft: 0 });
  assert.deepEqual(rewardProgress(17), { every: 14, current: 3, daysLeft: 11 });
});

test("each badge is celebrated only once", () => {
  const first = takeNewBadges({ bestStreak: 7, wordsLearned: 0, totalStars: 0 });
  assert.deepEqual(first.map((b) => b.id), ["streak3", "streak7"]);
  assert.deepEqual(takeNewBadges({ bestStreak: 7, wordsLearned: 0, totalStars: 0 }), []);
  assert.deepEqual(takeNewBadges({ bestStreak: 7, wordsLearned: 12, totalStars: 0 }).map((b) => b.id), ["words10"]);
});
