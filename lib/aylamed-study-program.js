function clean(value = '', maximum = 300) {
  return String(value ?? '').trim().slice(0, maximum);
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

export function validateAylaStudyProgramManifest(manifest = {}, { expectedBlockCount, expectedQuestionIds = [] } = {}) {
  const program = manifest.program || {};
  const blocks = rows(manifest.blocks);
  const errors = [];
  const blockIds = new Set();
  const questionIds = [];
  let priorOrder = 0;
  for (const block of blocks) {
    const blockId = clean(block.block_id || block.id);
    const order = Number(block.order);
    if (!blockId || blockIds.has(blockId)) errors.push(`duplicate_or_missing_block_id:${blockId || 'blank'}`);
    blockIds.add(blockId);
    if (!Number.isInteger(order) || order <= priorOrder) errors.push(`invalid_block_order:${blockId}`);
    priorOrder = order;
    const refs = rows(block.question_ids).map((id) => clean(id)).filter(Boolean);
    if (!refs.length) errors.push(`empty_block:${blockId}`);
    if (new Set(refs).size !== refs.length) errors.push(`duplicate_question_inside_block:${blockId}`);
    questionIds.push(...refs);
  }
  if (Number.isInteger(expectedBlockCount) && blocks.length !== expectedBlockCount) {
    errors.push(`block_count:${blocks.length}/${expectedBlockCount}`);
  }
  const duplicates = [...new Set(questionIds.filter((id, index) => questionIds.indexOf(id) !== index))];
  if (duplicates.length) errors.push(`duplicate_question_references:${duplicates.length}`);
  const expected = new Set(expectedQuestionIds.map((id) => clean(id)).filter(Boolean));
  const actual = new Set(questionIds);
  const missing = [...expected].filter((id) => !actual.has(id));
  const unknown = [...actual].filter((id) => expected.size && !expected.has(id));
  if (missing.length) errors.push(`missing_question_references:${missing.length}`);
  if (unknown.length) errors.push(`unknown_question_references:${unknown.length}`);
  if (!clean(program.source_bank_collection_key)) errors.push('source_bank_collection_key_required');
  return {
    valid: errors.length === 0,
    errors,
    block_count: blocks.length,
    reference_count: questionIds.length,
    unique_reference_count: actual.size,
    duplicate_question_ids: duplicates,
    missing_question_ids: missing,
    unknown_question_ids: unknown,
  };
}

export function buildAylaStudyProgramRoadmapTasks(manifest = {}, {
  studentId,
  startDate,
  now = new Date().toISOString(),
} = {}) {
  const program = manifest.program || {};
  const start = new Date(`${clean(startDate, 10)}T12:00:00.000Z`);
  if (!studentId || Number.isNaN(start.getTime())) throw new Error('studentId and a valid startDate are required');
  return rows(manifest.blocks).map((block, index) => {
    const scheduled = new Date(start);
    scheduled.setUTCDate(scheduled.getUTCDate() + index);
    return {
      id: `${clean(program.id)}:${clean(studentId)}:${clean(block.block_id || block.id)}`,
      type: 'study_program_block',
      category: 'internal_mcqs',
      studentId: clean(studentId),
      examTrack: clean(program.exam_track),
      programId: clean(program.id),
      programBlockId: clean(block.block_id || block.id),
      programOrder: Number(block.order),
      sourceBankCollectionKey: clean(program.source_bank_collection_key),
      resourceIds: rows(block.question_ids).map((id) => clean(id)).filter(Boolean),
      scoringMode: 'source_bank',
      programCompletionNamespace: clean(program.progress_namespace),
      scheduledDate: scheduled.toISOString().slice(0, 10),
      originalScheduledDate: scheduled.toISOString().slice(0, 10),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function rescheduleAylaStudyProgramTask(task = {}, { scheduledDate, priority } = {}) {
  const nextDate = clean(scheduledDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) throw new Error('A valid scheduledDate is required');
  return {
    ...task,
    scheduledDate: nextDate,
    priority: clean(priority || task.priority || 'Normal', 40),
    resourceIds: [...rows(task.resourceIds)],
    programId: task.programId,
    programBlockId: task.programBlockId,
    programOrder: task.programOrder,
    originalScheduledDate: task.originalScheduledDate,
    rescheduledAt: new Date().toISOString(),
  };
}

export function aylaStudyProgramTutorReferences(task = {}, { flashcardCollectionId = '' } = {}) {
  return {
    exam_track: clean(task.examTrack),
    source_bank_collection_key: clean(task.sourceBankCollectionKey),
    question_ids: [...new Set(rows(task.resourceIds).map((id) => clean(id)).filter(Boolean))],
    flashcard_collection_id: clean(flashcardCollectionId),
    duplicate_question_records_created: 0,
    duplicate_attempt_records_created: 0,
  };
}
