import crypto from "node:crypto";

function requiredText(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function orderOptionsForAttempt(question, attemptSeed) {
  const draftId = requiredText(question?.draft_id, "question.draft_id");
  const seed = requiredText(attemptSeed, "attemptSeed");
  const options = Array.isArray(question?.options) ? question.options : [];

  return options
    .map((option, originalIndex) => {
      const optionId = requiredText(option?.id, `option[${originalIndex}].id`);
      const rank = crypto
        .createHash("sha256")
        .update(`aylamed-answer-order-v1\u0000${seed}\u0000${draftId}\u0000${optionId}`)
        .digest("hex");
      return { option, originalIndex, rank };
    })
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.originalIndex - right.originalIndex)
    .map(({ option }) => option);
}

export function correctPositionForAttempt(question, attemptSeed) {
  const correctId = String(question?.correct_option_id ?? "");
  const index = orderOptionsForAttempt(question, attemptSeed)
    .findIndex((option) => String(option?.id ?? "") === correctId);
  return index < 0 ? 0 : index + 1;
}
