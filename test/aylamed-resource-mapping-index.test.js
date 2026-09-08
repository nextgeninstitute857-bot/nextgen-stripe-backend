import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createAylaResourceMappingIndex } from "../lib/aylamed-resource-mapping-index.js";

const key = value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const identity = value => value || null;
const bindings = { examTrack: identity, resourceType: identity, mappingKey: key };

test("mapping index preserves explicit IDs, source order, subsystem matching and exam isolation", () => {
  const rows = [
    { id: "wrong-exam", exam: "step2", type: "book", system: "Cardio", topic: "Valve" },
    { id: "blocked", exam: "step1", type: "book", system: "Cardio", topic: "Valve", approved: false },
    { id: "first", exam: "step1", type: "book", system: "Cardio", topic: "Valve", subsystem: "A" },
    { id: "second", exam: "step1", type: "book", system: "Cardio", topic: "Valve", subsystem: "B" },
    { id: "video", exam: "step1", type: "vimeo_video", system: "Cardio", topic: "Valve", subsystem: "B" },
    { id: "explicit", exam: "step1", type: "reading", system: "Other", topic: "Other" },
  ];
  const index = createAylaResourceMappingIndex(rows, bindings);
  const resource = { exam: "step1", system: "CARDIO", topic: " Valve " };
  assert.equal(index.resolve(resource).book, rows[2]);
  assert.equal(index.resolve({ ...resource, subsystem: "B" }).book, rows[3]);
  assert.equal(index.resolve({ ...resource, subsystem: "B" }).video, rows[4]);
  assert.equal(index.resolve({ ...resource, mappedBookResourceId: "explicit" }).book, rows[5]);
  assert.equal(index.resolve({ ...resource, mappedBookResourceId: "missing" }).book, rows[2]);
  assert.equal(index.resolve({ ...resource, mappedBookResourceId: "wrong-exam" }).book, rows[2]);
  assert.equal(index.resolve({ ...resource, subsystem: "unknown" }).book, null);
  assert.equal(index.resolve({ exam: "step1", system: "Cardio", topic: "" }).book, null);
  assert.equal(index.resolve({ ...resource, exam: "unknown" }).book, null);
});

test("mapping index excludes denied states and retains the legacy explicit-ID behavior", () => {
  const rows = [
    ...["quarantined", "DISABLED", "deleted", "rejected", "archived"].map(status => ({ id: status, exam: "step1", type: "book", system: "C", topic: "T", status })),
    { id: "same", exam: "step1", type: "flashcard", title: "First explicit match" },
    { id: "same", exam: "step1", type: "book", title: "Duplicate ID" },
    { id: "good", exam: "step1", type: "reading", system: "C", topic: "T" },
  ];
  const index = createAylaResourceMappingIndex(rows, bindings);
  assert.equal(index.resolve({ exam: "step1", system: "C", topic: "T" }).book.id, "good");
  assert.equal(index.resolve({ exam: "step1", mappedBookResourceId: "same" }).book.title, "First explicit match");
});

function resourceSelector(extraBindings = {}) {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf("function aylaV189ResourceMappingIndex");
  const end = server.indexOf("function aylaV210StudentFeatureAllowed", start);
  assert.ok(start > 0 && end > start);
  const helpers = {
    createAylaResourceMappingIndex,
    aylaValues: (db, collection) => Object.values(db[collection] || {}),
    aylaCanonicalExamTrack: identity,
    aylaV189ResourceType: identity,
    aylaV189MappingKey: key,
    aylaV189PageRange: row => row.pageRange || "",
    aylaCleanArray: value => Array.isArray(value) ? value : [],
    aylaV189SystemProgress: () => [],
    aylaPilotContentScope: () => ({ pilotOnly: false }),
    aylaPilotContentVisibleToStudent: () => true,
    aylaStep1PilotVimeoVisibleToStudent: () => true,
    aylaResourcePublishedFor: (_db, row) => ({ allowed: row.published !== false }),
    aylaNumber: (value, fallback) => Number(value ?? fallback),
    ...extraBindings,
  };
  return new Function(...Object.keys(helpers), `${server.slice(start, end)}; return aylaV189RelevantResources;`)(...Object.values(helpers));
}

test("real resource selector rechecks current publication and student ownership without caching results", () => {
  const select = resourceSelector();
  const student = { id: "s", exam: "step1" };
  const resource = { id: "book", exam: "step1", type: "book", system: "C", topic: "T", bookTitle: "Current" };
  const db = { aylaResources: { resource } };
  assert.equal(select(db, student, ["book"])[0].mappedBookTitle, "Current");
  resource.bookTitle = "Updated";
  assert.equal(select(db, student, ["book"])[0].mappedBookTitle, "Updated");
  resource.published = false;
  assert.deepEqual(select(db, student, ["book"]), []);
  resource.published = true; resource.ownerStudentId = "other";
  assert.deepEqual(select(db, student, ["book"]), []);
  assert.equal(select(db, { ...student, id: "other" }, ["book"]).length, 1);
});

test("real selector builds the mapping lookup once instead of scanning all resources per reading", () => {
  let scans = 0;
  const select = resourceSelector({ aylaValues: (db, collection) => { scans++; return Object.values(db[collection] || {}); } });
  const db = { aylaResources: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [index, {
    id: String(index), exam: "step1", type: index % 2 ? "vimeo_video" : "book", system: "C", topic: `T${index}`,
  }])) };
  assert.equal(select(db, { id: "s", exam: "step1" }, ["book"]).length, 250);
  assert.equal(scans, 2);
});
