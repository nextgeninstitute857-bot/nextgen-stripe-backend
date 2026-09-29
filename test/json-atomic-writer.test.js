import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { eventLoopDelayStats, jsonWriteStats, writeJsonAtomicStreaming } from "../lib/json-atomic-writer.js";

const tricky = {
  users: { u1: { id: "u1", name: "Ayşe \"quoted\" \\ back\nslash", emoji: "🧠🫀", tab: "\t", skip: undefined, fn() {}, n: NaN, inf: Infinity, neg: -0, date: new Date("2026-09-29T10:00:00Z") } },
  emailLogs: [{ id: 1, list: [1, undefined, null, () => {}, "x"] }, "plain", 3, null, undefined, true],
  nested: { deep: { deeper: { deepest: [{ a: [{ b: "c" }] }] } } },
  empty: {},
  emptyList: [],
  bigString: "é".repeat(700_000),
  withToJSON: { toJSON() { return { replaced: true }; } },
  skippedTop: undefined,
  "key with \"quotes\"": { "ключ": "значение" },
  updatedAt: null,
};

test("output is byte-identical to JSON.stringify for tricky data", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-writer-"));
  const file = path.join(dir, "db.json");
  await writeJsonAtomicStreaming(file, tricky, "tricky");
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(tricky));
  await assert.rejects(fs.access(`${file}.tmp`), "temp file is renamed away");
  assert.equal(jsonWriteStats().tricky.count, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("gzip output round-trips to the same JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-writer-gz-"));
  const file = path.join(dir, "db.json.gz");
  await writeJsonAtomicStreaming(file, tricky, "tricky-gz", { gzip: true });
  assert.equal(gunzipSync(await fs.readFile(file)).toString("utf8"), JSON.stringify(tricky));
  await fs.rm(dir, { recursive: true, force: true });
});

test("a failed write leaves the previous file untouched and removes the temp file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-writer-fail-"));
  const file = path.join(dir, "db.json");
  await fs.writeFile(file, "{\"old\":true}");
  const circular = { a: {} };
  circular.a.self = circular.a;
  await assert.rejects(writeJsonAtomicStreaming(file, { col: { rec: circular.a } }, "circular"), TypeError);
  assert.equal(await fs.readFile(file, "utf8"), "{\"old\":true}");
  await assert.rejects(fs.access(`${file}.tmp`));
  assert.equal(jsonWriteStats().circular.failures, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("event loop delay stats are reported", () => {
  const stats = eventLoopDelayStats();
  for (const key of ["p50_ms", "p99_ms", "max_ms", "mean_ms", "window_seconds"]) assert.equal(typeof stats[key], "number");
});
