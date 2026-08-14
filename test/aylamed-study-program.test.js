import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aylaStudyProgramTutorReferences,
  buildAylaStudyProgramRoadmapTasks,
  rescheduleAylaStudyProgramTask,
  validateAylaStudyProgramManifest,
} from '../lib/aylamed-study-program.js';

const manifest = {
  program: {
    id: 'amboss-step2-study-plan-2025',
    exam_track: 'usmle_step_2_ck',
    source_bank_collection_key: 'amboss-step2-ck-2025',
    progress_namespace: 'amboss-step2-study-plan-2025',
  },
  blocks: [
    { block_id: 'block-1', order: 1, question_ids: ['q1', 'q2'] },
    { block_id: 'block-2', order: 2, question_ids: ['q3'] },
  ],
};

test('study-program validation proves question references without creating a second bank', () => {
  const result = validateAylaStudyProgramManifest(manifest, { expectedBlockCount: 2, expectedQuestionIds: ['q1', 'q2', 'q3'] });
  assert.equal(result.valid, true);
  assert.equal(result.reference_count, 3);
  assert.equal(result.unique_reference_count, 3);
});

test('roadmap tasks preserve block order and source-bank question identity', () => {
  const tasks = buildAylaStudyProgramRoadmapTasks(manifest, { studentId: 'student-1', startDate: '2026-09-01', now: '2026-08-14T00:00:00.000Z' });
  assert.deepEqual(tasks.map((task) => task.programOrder), [1, 2]);
  assert.deepEqual(tasks[0].resourceIds, ['q1', 'q2']);
  assert.equal(tasks[0].sourceBankCollectionKey, 'amboss-step2-ck-2025');
  assert.equal(tasks[0].scoringMode, 'source_bank');
});

test('rescheduling changes timing only and keeps the immutable program reference', () => {
  const [task] = buildAylaStudyProgramRoadmapTasks(manifest, { studentId: 'student-1', startDate: '2026-09-01' });
  const moved = rescheduleAylaStudyProgramTask(task, { scheduledDate: '2026-09-08', priority: 'High' });
  assert.equal(moved.scheduledDate, '2026-09-08');
  assert.equal(moved.originalScheduledDate, '2026-09-01');
  assert.deepEqual(moved.resourceIds, task.resourceIds);
  assert.equal(moved.programBlockId, task.programBlockId);
});

test('Personal Tutor references QBank and flashcards without duplicate questions or attempts', () => {
  const [task] = buildAylaStudyProgramRoadmapTasks(manifest, { studentId: 'student-1', startDate: '2026-09-01' });
  const refs = aylaStudyProgramTutorReferences(task, { flashcardCollectionId: 'step2-flash-2025' });
  assert.deepEqual(refs.question_ids, ['q1', 'q2']);
  assert.equal(refs.flashcard_collection_id, 'step2-flash-2025');
  assert.equal(refs.duplicate_question_records_created, 0);
  assert.equal(refs.duplicate_attempt_records_created, 0);
});

test('duplicate and unknown references fail closed', () => {
  const invalid = { ...manifest, blocks: [{ block_id: 'block-1', order: 1, question_ids: ['q1', 'q1', 'q9'] }] };
  const result = validateAylaStudyProgramManifest(invalid, { expectedBlockCount: 1, expectedQuestionIds: ['q1'] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith('duplicate_question_inside_block')));
  assert.ok(result.errors.some((error) => error.startsWith('unknown_question_references')));
});
