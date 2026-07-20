function cleanSystem(value = "") {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function flashcardMatchesCurrentSystem(card = {}, currentSystem = "") {
  const target = cleanSystem(currentSystem);
  if (!target) return false;
  const values = [card.system, card.current_system, card.topic, card.tag]
    .map(cleanSystem)
    .filter(Boolean);
  return values.some((value) => value === target || value.includes(target) || target.includes(value));
}

export function flashcardPriorityRank(card = {}, currentSystem = "") {
  const bucket = String(card.bucket || "published_bank");
  if (bucket === "weak_area") return 0;
  if (bucket === "tutor_notes" && flashcardMatchesCurrentSystem(card, currentSystem)) return 1;
  if (bucket === "class_first_aid" && flashcardMatchesCurrentSystem(card, currentSystem)) return 2;
  if (bucket === "tutor_notes") return 3;
  if (bucket === "class_first_aid") return 4;
  return 5;
}
