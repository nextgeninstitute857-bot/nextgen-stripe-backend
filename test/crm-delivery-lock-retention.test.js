import test from "node:test";
import assert from "node:assert/strict";

import { planCrmDeliveryLockRetention } from "../lib/crm-delivery-lock-retention.js";

test("delivery-lock retention does nothing below the trigger", () => {
  const locks = [{ id: "a" }, { id: "b" }];

  assert.equal(
    planCrmDeliveryLockRetention(locks, { trigger: 3, keep: 2 }),
    null,
  );
  assert.deepEqual(locks, [{ id: "a" }, { id: "b" }]);
});

test("delivery-lock retention archives the old append-only prefix", () => {
  const locks = Array.from({ length: 10 }, (_, index) => ({ id: `lock-${index}` }));
  const plan = planCrmDeliveryLockRetention(locks, { trigger: 8, keep: 4 });

  assert.equal(plan.before, 10);
  assert.equal(plan.kept, 4);
  assert.equal(plan.archived, 6);
  assert.equal(plan.strategy, "append_order_tail");
  assert.deepEqual(plan.archive.map((lock) => lock.id), [
    "lock-0",
    "lock-1",
    "lock-2",
    "lock-3",
    "lock-4",
    "lock-5",
  ]);
  assert.deepEqual(plan.keep.map((lock) => lock.id), [
    "lock-6",
    "lock-7",
    "lock-8",
    "lock-9",
  ]);
  assert.equal(locks.length, 10);
});

test("delivery-lock retention clamps unsafe configuration", () => {
  const locks = Array.from({ length: 6 }, (_, index) => index);
  const plan = planCrmDeliveryLockRetention(locks, { trigger: 4, keep: 99 });

  assert.equal(plan.kept, 4);
  assert.equal(plan.archived, 2);
  assert.deepEqual(plan.keep, [2, 3, 4, 5]);
});

test("delivery-lock retention handles the production-scale collection without sorting", () => {
  const lockCount = 700_000;
  const locks = Array.from({ length: lockCount }, (_, index) => index);
  const plan = planCrmDeliveryLockRetention(locks, { trigger: 8_000, keep: 4_000 });

  assert.equal(plan.before, lockCount);
  assert.equal(plan.archived, 696_000);
  assert.equal(plan.kept, 4_000);
  assert.equal(plan.archive[0], 0);
  assert.equal(plan.archive[plan.archive.length - 1], 695_999);
  assert.equal(plan.keep[0], 696_000);
  assert.equal(plan.keep[plan.keep.length - 1], 699_999);
});
