import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeContentTaxonomyExamTrack } from '../lib/content-taxonomy-control.js';
import { normalizeAylaShellExamTrack } from '../lib/aylamed-student-shell.js';
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('app.get("/api/ayla/admin/resources/content-taxonomy/questions",');
const end = source.indexOf('app.post("/api/ayla/admin/resources/content-taxonomy/mappings",', start);
const id = '00000000-0000-4000-8000-000000000001';
function harness() {
  const routes = new Map(), calls = [];
  const registry = Object.fromEntries(['usmle_step_1', 'usmle_step_2_ck', 'usmle_step_3', 'mccqe', 'plab', 'amc', 'nclex'].map(exam => [exam, { systems: [`${exam} canonical system`] }]));
  const context = { app: { get: (path, fn) => routes.set(`GET ${path}`, fn), post: (path, fn) => routes.set(`POST ${path}`, fn) },
    normalizeContentTaxonomyExamTrack, normalizeAylaShellExamTrack, AYLA_EXAM_REGISTRY: registry,
    aylaRequireAdmin: async req => {
      if (!req.admin) throw Object.assign(new Error('Admin access required'), { statusCode: 403 });
      return { user: { id: 'authenticated-admin' } };
    },
    getContentQuestionTaxonomyReviewPage: async args => { calls.push(args); return { count: 1, questions: [{ id }] }; },
    importContentQuestionTaxonomyReview: async (input, args) => { calls.push({ input, ...args }); if (input.injectFailure) throw new Error('Private database connection details'); return { valid: true, applied: input.apply === true }; },
    aylaSendOk: (res, payload) => ({ status: 200, body: { success: true, ...payload } }),
    aylaSendError: (res, status, error, details) => ({ status, body: { success: false, error, details } }),
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { calls, async call(method, input, admin = true) {
    const headers = {}; const result = await routes.get(`${method} /api/ayla/admin/resources/content-taxonomy/${method === 'GET' ? 'questions' : 'question-mapping-import'}`)(
      { query: input, body: input, admin }, { setHeader: (name, value) => { headers[name] = value; } });
    return { ...result, headers };
  } };
}

test('actual evidence/import handlers enforce admin identity and selected exam before database access', async () => {
  const app = harness();
  assert.equal((await app.call('GET', { exam_track: 'usmle_step_1' }, false)).status, 403);
  assert.equal((await app.call('POST', { exam_track: 'usmle_step_1', apply: true }, false)).status, 403);
  assert.equal((await app.call('POST', { exam_track: 'invented' })).status, 400);
  assert.equal(app.calls.length, 0);
  for (const exam of ['usmle_step_1', 'usmle_step_2_ck', 'usmle_step_3', 'mccqe', 'plab', 'amc', 'nclex']) {
    const response = await app.call('GET', { exam_track: exam, question_ids: id, source_namespace: 'selected-source' });
    assert.equal(response.status, 200); assert.equal(response.headers['Cache-Control'], 'private, no-store');
    assert.equal(app.calls.at(-1).allowedSystems[0], `${exam} canonical system`);
    assert.deepEqual(Array.from(app.calls.at(-1).questionIds), [id]);
    assert.equal(app.calls.at(-1).sourceNamespace, 'selected-source');
  }
  assert.equal((await app.call('GET', { exam_track: 'plab', question_ids: [id] })).status, 400);
});

test('actual import handler uses authenticated review actor and returns safe errors', async () => {
  const app = harness();
  const response = await app.call('POST', { exam_track: 'usmle_step_2_ck', actorId: 'untrusted-actor', allowedSystems: ['Untrusted system'], apply: false });
  assert.equal(response.status, 200); assert.equal(response.body.applied, false);
  assert.equal(app.calls[0].actorId, 'authenticated-admin');
  assert.equal(app.calls[0].allowedSystems[0], 'usmle_step_2_ck canonical system');
  assert.equal(app.calls[0].input.exam_track, 'usmle-step-2');
  const failed = await app.call('POST', { exam_track: 'plab', injectFailure: true });
  assert.equal(failed.status, 500); assert.equal(failed.body.error, 'Failed to save reviewed question classifications');
  assert.equal(JSON.stringify(failed).includes('database connection'), false);
});
