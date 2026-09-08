// Derive filter state only from the authenticated learner's current exam scope.
// Test correctness is excluded until submission, including legacy locked answers.
export function aylaQbankFilterHistory(sessions, { userId, studentId, examTrack, examVariant = "" }) {
  const seen = new Set(), marked = new Set(), latest = new Map();
  for (const session of sessions) {
    if (String(session.userId) !== String(userId) || String(session.studentId) !== String(studentId)
      || String(session.examTrack) !== String(examTrack)
      || (examVariant && String(session.nclexVariant || session.nclex_variant || "") !== examVariant)) continue;
    for (const row of session.questions || []) {
      const id = String(row.contentQuestionId || "");
      if (!id) continue;
      const answer = session.answers?.[row.ref];
      if (answer || session.draftAnswers?.[row.ref]) seen.add(id);
      if (session.marks?.[row.ref]) marked.add(id);
      if (!answer || (session.mode !== "tutor" && session.status !== "submitted")) continue;
      const timestamp = String(session.submittedAt || answer.answeredAt || session.updatedAt || "");
      if (!latest.has(id) || timestamp > latest.get(id).timestamp) latest.set(id, { timestamp, incorrect: answer.correct === false });
    }
  }
  return { seenQuestionIds: [...seen], markedQuestionIds: [...marked], incorrectQuestionIds: [...latest].filter(([, row]) => row.incorrect).map(([id]) => id) };
}
