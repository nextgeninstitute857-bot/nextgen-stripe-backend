import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizeAylaQbankFilters } from "../lib/aylamed-qbank.js";
import { resolveContentQbankStudentCollectionIds } from "../lib/content-registry-postgres.js";
import { aylaQbankFilterHistory } from "../lib/aylamed-qbank-history.js";
import { buildAylaQbankFacetTree, mergeAylaQbankFacets } from "../lib/aylamed-qbank-facets.js";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
function harness() {
  const requests = [], routes = new Map();
  const banks = [1, 2].map(n => ({ id: id(n), source_exam_track: "plab", question_count: 2 }));
  const student = { id: "s" }, user = { id: "u" };
  const db = { aylaQbankSessions: { owned: { userId: "u", studentId: "s", examTrack: "plab", mode: "tutor", questions: [{ ref: "r", contentQuestionId: id(10) }], answers: { r: { correct: false, answeredAt: "2026-09-08T10:00:00Z" } } } } };
  const context = {
    app: { get: (path, fn) => routes.set(path, fn), post: (path, fn) => routes.set(path, fn) },
    aylaV189RequireStudent: async (req, sid) => {
      if (sid !== "s") throw Object.assign(new Error("Wrong learner"), { statusCode: 403 });
      return { db, student, user };
    },
    aylaRequireQbankAccess: () => ({ exam_track: "plab" }), requireAylaNclexVariant: () => "",
    aylaRequireExamPublished: () => {}, aylaCanonicalExamTrack: exam => exam,
    aylaStudentCatalogDestinationScope: () => "private-scope", aylaAvailableQbankBanks: async () => banks,
    aylaRequestedQbankCollectionIds: rows => rows, resolveContentQbankStudentCollectionIds,
    normalizeAylaQbankFilters, aylaQbankFilterHistory, mergeAylaQbankFacets,
    aylaValues: (state, key) => Object.values(state[key] || {}),
    getContentQbankFacets: async options => {
      requests.push(options);
      return { ...buildAylaQbankFacetTree([{ system_key: "renal", system_label: "Renal", question_count: 2, mapping_status: "source_grouping" }], { examTrack: options.examTrack }), source_exam_track: options.examTrack };
    },
    aylaSendOk: (res, body) => ({ status: 200, body }), aylaSendError: (res, status, message, details) => ({ status, message, details }),
  };
  const policyStart = source.indexOf("function aylaStudentSelectableQbankPolicy(");
  vm.runInNewContext(source.slice(policyStart, source.indexOf("\n}\n", policyStart) + 3), context);
  const routeStart = source.indexOf("async function aylaQbankFacetsForLearner(");
  vm.runInNewContext(source.slice(routeStart, source.indexOf('app.post("/api/ayla/qbank/sessions",', routeStart)), context);
  return { requests, call: (count, input) => routes.get(`/api/ayla/qbank/${count ? "selection-count" : "facets"}`)({ body: input, query: input }, { setHeader: () => {} }) };
}

test("real facets/count routes accept explicit published banks and preserve server-only exam history", async () => {
  const ctx = harness();
  const response = await ctx.call(false, { student_id: "s", collection_ids: [id(1)], difficulty: "hard", status: "incorrect", history: { incorrectQuestionIds: [id(99)] } });
  assert.equal(response.status, 200);
  assert.deepEqual(Array.from(ctx.requests[0].collectionIds), [id(1)]);
  assert.equal(ctx.requests[0].destinationScope, "private-scope");
  assert.equal(ctx.requests[0].filters.difficulty, "hard");
  assert.deepEqual(ctx.requests[0].history.incorrectQuestionIds, [id(10)]);
  const counted = await ctx.call(true, { student_id: "s", collection_ids: [id(1), id(2)], filters: { selection_paths: [{ system_key: "renal" }], status: "marked" } });
  assert.equal(counted.status, 200);
  assert.equal(ctx.requests.length, 2, "two banks in one source exam produce one query");
  assert.equal(ctx.requests[1].filters.selection_paths[0].system_key, "renal");
  assert.equal(ctx.requests[1].filters.status, "marked");
});

test("real facet routes reject unavailable banks and other learner profiles before querying content", async () => {
  const ctx = harness();
  assert.equal((await ctx.call(false, { student_id: "s", collection_ids: [id(99)] })).status, 400);
  assert.equal((await ctx.call(true, { student_id: "other", collection_ids: [id(1)] })).status, 403);
  assert.equal(ctx.requests.length, 0);
});
