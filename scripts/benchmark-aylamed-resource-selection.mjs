import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createAylaResourceMappingIndex } from "../lib/aylamed-resource-mapping-index.js";
import { mutateJsonCopyOnWrite, mutateJsonCollectionsCopyOnWrite } from "../lib/json-copy-on-write.js";

const key = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const count = Number(process.env.AYLA_BENCHMARK_RESOURCE_COUNT || 20_000);
const readEvery = Number(process.env.AYLA_BENCHMARK_READING_EVERY || 20);
const baseline = execFileSync("git", ["show", "66c971f:server.js"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const current = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
function selector(server) {
  const start = server.indexOf("function aylaV189ResourceMappingIndex") >= 0
    ? server.indexOf("function aylaV189ResourceMappingIndex") : server.indexOf("function aylaV189EnrichResourceMappings");
  const end = server.indexOf("function aylaV210StudentFeatureAllowed", start);
  const helpers = {
    createAylaResourceMappingIndex,
    aylaValues: (db, collection) => Object.values(db[collection] || {}),
    aylaCanonicalExamTrack: value => value || null,
    aylaV189ResourceType: value => value,
    aylaV189MappingKey: key,
    aylaV189PageRange: row => row.pageRange || "",
    aylaCleanArray: value => Array.isArray(value) ? value : [],
    aylaV189SystemProgress: () => [],
    aylaPilotContentScope: () => ({ pilotOnly: false }),
    aylaPilotContentVisibleToStudent: () => true,
    aylaStep1PilotVimeoVisibleToStudent: () => true,
    aylaResourcePublishedFor: () => ({ allowed: true }),
    aylaNumber: (value, fallback) => Number(value ?? fallback),
  };
  return new Function(...Object.keys(helpers), `${server.slice(start, end)}; return aylaV189RelevantResources;`)(...Object.values(helpers));
}
const db = { aylaResources: Object.fromEntries(Array.from({ length: count }, (_, index) => [index, {
  id: String(index), exam: "step1", type: index % readEvery === 0 ? "reading" : index % 3 ? "flashcard" : "vimeo_video",
  system: `System ${index % 12}`, topic: `Topic ${index % 137}`, subsystem: index % 2 ? "A" : "B",
  bookTitle: `Book ${index}`, content: "synthetic content ".repeat(310),
}])) };
const student = { id: "synthetic", exam: "step1" };
const oldSelect = selector(baseline); const newSelect = selector(current);
const report = { resources: count, readings: Math.ceil(count / readEvery), syntheticJsonBytes: Buffer.byteLength(JSON.stringify(db)), timingsMs: {} };
let expected;
async function measure(name, run) {
  const start = performance.now();
  const rows = await run();
  report.timingsMs[name] = Math.round(performance.now() - start);
  const summary = rows.map(row => [row.id, row.mappedBookResourceId, row.mappedBookTitle, row.mappedVideoResourceId, row.mappingStatus, row.relevance]);
  if (!expected) expected = summary; else assert.deepEqual(summary, expected);
  console.log(JSON.stringify({ phase: name, milliseconds: report.timingsMs[name], resultCount: rows.length }));
}
await measure("baseline_plain", () => oldSelect(db, student, ["reading"]));
await measure("indexed_plain", () => newSelect(db, student, ["reading"]));
await measure("indexed_scoped_background_draft", async () => (await mutateJsonCollectionsCopyOnWrite(db,
  ["aylaDailyPlans", "aylaResourceAssignments", "aylaRevisionQueue", "aylaQbankSessions"],
  draft => newSelect(draft, student, ["reading"]))).result);
if (process.env.AYLA_BENCHMARK_SKIP_LEGACY_PROXY !== "true") {
  await measure("baseline_full_background_draft", async () => (await mutateJsonCopyOnWrite(db,
    draft => oldSelect(draft, student, ["reading"]))).result);
}
console.log(JSON.stringify(report, null, 2));
