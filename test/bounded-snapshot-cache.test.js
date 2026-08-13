import test from "node:test";
import assert from "node:assert/strict";
import { createBoundedSnapshotCache } from "../lib/bounded-snapshot-cache.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

for (const callers of [4, 8]) {
  test(`${callers} identical registry reads share one calculation`, async () => {
    const cache = createBoundedSnapshotCache({ ttlMs: 1000 });
    let calculations = 0;
    const values = await Promise.all(Array.from({ length: callers }, () => cache.read("registry:all:200:0", async () => {
      calculations += 1;
      await delay(15);
      return { revision: calculations };
    })));

    assert.equal(calculations, 1);
    assert.deepEqual(values, Array.from({ length: callers }, () => ({ revision: 1 })));
  });
}

test("successful snapshots are short-lived and every mutation invalidates them", async () => {
  let timestamp = 1000;
  const cache = createBoundedSnapshotCache({ ttlMs: 500, now: () => timestamp });
  let calculations = 0;
  const read = () => cache.read("registry", async () => ({ revision: ++calculations }));

  assert.deepEqual(await read(), { revision: 1 });
  assert.deepEqual(await read(), { revision: 1 });

  const mutations = ["import", "media_attachment", "mapping", "collection_approval", "destination_change"];
  for (const mutation of mutations) {
    cache.invalidate(mutation);
    const before = calculations;
    const value = await read();
    assert.equal(calculations, before + 1);
    assert.deepEqual(value, { revision: calculations });
  }

  timestamp += 501;
  const beforeExpiry = calculations;
  const expiredValue = await read();
  assert.equal(calculations, beforeExpiry + 1);
  assert.deepEqual(expiredValue, { revision: calculations });
});

test("errors and timeouts are coalesced only while running and are never cached", async () => {
  const cache = createBoundedSnapshotCache({ ttlMs: 1000 });
  let calculations = 0;
  const failing = () => cache.read("registry", async () => {
    calculations += 1;
    await delay(10);
    throw Object.assign(new Error("bounded failure"), { code: "BOUNDED_FAILURE" });
  });

  const first = await Promise.allSettled([failing(), failing(), failing(), failing()]);
  assert.equal(calculations, 1);
  assert.equal(first.every((result) => result.status === "rejected"), true);

  await assert.rejects(failing(), { code: "BOUNDED_FAILURE" });
  assert.equal(calculations, 2);
  assert.equal(cache.status().cached_entries, 0);
});

test("a three-connection budget handles eight concurrent dashboard waves", async () => {
  const cache = createBoundedSnapshotCache({ ttlMs: 1000 });
  let active = 0;
  let peak = 0;
  let calculations = 0;
  const databaseRead = async (name) => {
    if (active >= 3) throw Object.assign(new Error("database is busy"), { code: "POOL_BUSY" });
    active += 1;
    peak = Math.max(peak, active);
    calculations += 1;
    try {
      await delay(20);
      return { name };
    } finally {
      active -= 1;
    }
  };

  const requests = Array.from({ length: 8 }, () => [
    cache.read("collections:all:200:0", () => databaseRead("registry")),
    cache.read("collections:all:200:0", () => databaseRead("publication-controls")),
    cache.read("global-publication:step-1", () => databaseRead("global-publication")),
  ]).flat();
  const results = await Promise.all(requests);

  assert.equal(results.length, 24);
  assert.equal(calculations, 2);
  assert.equal(peak, 2);
});
