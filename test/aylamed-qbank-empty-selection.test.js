import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

// Exercise the actual selector's empty-bank boundary. Database selection is a
// boundary stub: an empty learner-owned bank set must never reach it or expand
// to the exam-wide collection inventory (including the other NCLEX variant).
function selectorHarness() {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function aylaSelectQbankSessionQuestions(');
  const end = source.indexOf('\n}\n', start) + 3;
  assert.ok(start >= 0 && end > start, 'actual server selector is available');
  const requests = [];
  let fallbackCalls = 0;
  const context = {
    crypto,
    normalizeAylaRegistryExamTrack: value => value,
    aylaPublishedQbankCollectionIds: async () => {
      fallbackCalls++;
      return ['other-variant-bank'];
    },
    listContentQbankQuestions: async options => {
      requests.push(options);
      return [{ id: 'question', collection_id: options.collectionIds[0] }];
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return {
    select: options => context.aylaSelectQbankSessionQuestions({
      db: {}, purpose: 'practice', requestedCount: 1, filters: {},
      selectedBanks: [], allowedCollectionIds: [], ...options,
    }),
    requests,
    fallbackCalls: () => fallbackCalls,
  };
}

test('ordinary practice with no available banks never expands to exam-wide content', async () => {
  const ctx = selectorHarness();
  const result = await ctx.select({ examTrack: 'plab' });
  assert.equal(result.selected.length, 0);
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.fallbackCalls(), 0);
});

test('an empty RN or PN bank set cannot select questions from the other variant', async () => {
  for (const examVariant of ['nclex_rn', 'nclex_pn']) {
    const ctx = selectorHarness();
    const result = await ctx.select({ examTrack: 'nclex', examVariant });
    assert.equal(result.selected.length, 0, examVariant);
    assert.equal(ctx.requests.length, 0, examVariant);
    assert.equal(ctx.fallbackCalls(), 0, examVariant);
  }
});

test('an explicit allowed bank set remains usable without expanding its scope', async () => {
  const ctx = selectorHarness();
  const result = await ctx.select({ examTrack: 'nclex', examVariant: 'nclex_rn', allowedCollectionIds: ['rn-bank'] });
  assert.equal(result.selected.length, 1);
  assert.deepEqual(Array.from(ctx.requests[0].collectionIds), ['rn-bank']);
  assert.equal(ctx.fallbackCalls(), 0);
});

test('named bank selection forwards the exact hierarchy and scoped status history', async () => {
  const ctx = selectorHarness();
  const paths = [{ system_key: 'renal', subsystem_key: 'renal-disease' }];
  const history = { seenQuestionIds: [], incorrectQuestionIds: ['question'], markedQuestionIds: [] };
  const result = await ctx.select({
    examTrack: 'plab', selectedBanks: [{ id: 'owned-bank', source_exam_track: 'plab' }],
    filters: { selection_paths: paths, status: 'incorrect', difficulty: 'hard' }, history,
  });
  assert.equal(result.selected.length, 1);
  assert.deepEqual(Array.from(ctx.requests[0].collectionIds), ['owned-bank']);
  assert.equal(ctx.requests[0].selectionPaths, paths);
  assert.equal(ctx.requests[0].status, 'incorrect');
  assert.equal(ctx.requests[0].difficulty, 'hard');
  assert.equal(ctx.requests[0].history, history);
  assert.equal(ctx.fallbackCalls(), 0);
});
