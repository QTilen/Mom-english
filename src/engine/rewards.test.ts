import "../test-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeUnlockReward, rewardProgress, setRewardText, starsFor, takeNewBadges } from "./rewards";

test("stars reward effort first, accuracy second", () => {
  assert.equal(starsFor(2, 8), 1);
  assert.equal(starsFor(6, 8), 2);
  assert.equal(starsFor(8, 8), 3);
});

test("rewards unlock once each at 14 days, then 1, 2, 6 and 12 months", () => {
  setRewardText(14, "Kosilo v restavraciji");
  assert.equal(maybeUnlockReward("2026-11-10", 13), undefined);
  const r = maybeUnlockReward("2026-11-11", 14);
  assert.equal(r?.reward_text, "Kosilo v restavraciji");
  // A new streak reaching 14 again doesn't pay out twice.
  assert.equal(maybeUnlockReward("2026-12-20", 14), undefined);
  assert.deepEqual(rewardProgress(17), { every: 30, label_sl: "1 mesec", current: 17, daysLeft: 13 });
  assert.equal(maybeUnlockReward("2026-11-27", 30)?.streak, 30);
  assert.equal(rewardProgress(31).every, 60);
  assert.equal(maybeUnlockReward("2027-01-01", 45), undefined);
});

test("each badge is celebrated only once", () => {
  const first = takeNewBadges({ bestStreak: 7, wordsLearned: 0, totalStars: 0 });
  assert.deepEqual(first.map((b) => b.id), ["streak3", "streak7"]);
  assert.deepEqual(takeNewBadges({ bestStreak: 7, wordsLearned: 0, totalStars: 0 }), []);
  assert.deepEqual(takeNewBadges({ bestStreak: 7, wordsLearned: 12, totalStars: 0 }).map((b) => b.id), ["words10"]);
});
