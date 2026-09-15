function cleanSystem(value = "") {
  const clean = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!clean) return "";
  if (clean === "cns" || clean.includes("central nervous") || clean.includes("neuro")) return "central nervous system";
  if (clean === "msk" || clean.includes("musculoskeletal") || clean.includes("bone") || clean.includes("joint")) return "msk";
  if (clean.includes("cardio") || clean.includes("heart")) return "cardiology";
  if (clean.includes("gastro") || clean === "gi" || clean === "git") return "git";
  if (clean.includes("renal") || clean.includes("kidney")) return "renal";
  if (clean.includes("pulm") || clean.includes("respiratory")) return "pulmonology";
  return clean;
}

export function flashcardMatchesCurrentSystem(card = {}, currentSystem = "") {
  const target = cleanSystem(currentSystem);
  if (!target) return false;
  const values = [card.system, card.current_system, card.topic, card.tag]
    .map(cleanSystem)
    .filter(Boolean);
  return values.some((value) => value === target || value.includes(target) || target.includes(value));
}

export function filterFlashcardsForSystem(cards = [], system = "") {
  const rows = Array.isArray(cards) ? cards : [];
  if (!cleanSystem(system)) return rows;
  return rows.filter((card) => flashcardMatchesCurrentSystem(card, system));
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
