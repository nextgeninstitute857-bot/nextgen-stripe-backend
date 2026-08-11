import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalAylaVimeoSystem } from "../lib/aylamed-vimeo-system-normalization.js";

const step1Systems = [
  "Cardiovascular",
  "Renal",
  "Respiratory",
  "Gastrointestinal",
  "Neurology",
  "Endocrine",
  "Reproductive",
  "Hematology",
  "Immunology",
  "Musculoskeletal",
  "Behavioral Science",
  "Biochemistry",
  "Pharmacology",
  "Microbiology",
  "Biostatistics and Ethics",
];

const normalize = (system, subsystem = "") => canonicalAylaVimeoSystem({
  examTrackId: "usmle_step_1",
  system,
  subsystem,
  allowedSystems: step1Systems,
});

test("reviewed Vimeo display labels normalize to Step 1 app systems", () => {
  const cases = [
    ["Nervous System", "Neuropathology", "Neurology"],
    ["Hematology and Oncology", "Leukemias and lymphomas", "Hematology"],
    ["Hematology & Oncology", "Acute leukemia", "Hematology"],
    ["Genetics", "Chromosomal Abnormalities", "Biochemistry"],
    ["Pulmonary", "Pulmonary pathology", "Respiratory"],
    ["General Pathology", "Neoplasia", "Biochemistry"],
    ["Dermatology", "Inflammatory skin disease", "Musculoskeletal"],
  ];
  for (const [system, subsystem, expected] of cases) {
    assert.equal(normalize(system, subsystem), expected, `${system} / ${subsystem}`);
  }
});

test("the imported Step 1 ledger composites use subsystem-aware normalization", () => {
  const cases = [
    ["Behavioral/Nervous/Special Senses", "Nervous System", "Neurology"],
    ["Behavioral/Nervous/Special Senses", "Psychiatric/Behavioral & Substance Use", "Behavioral Science"],
    ["Blood/Lymphoreticular/Immune", "Hematology & Oncology", "Hematology"],
    ["Blood/Lymphoreticular/Immune", "Allergy & Immunology", "Immunology"],
    ["Blood/Lymphoreticular/Immune", "Infectious Diseases", "Microbiology"],
    ["Reproductive/Endocrine", "Endocrine, Diabetes & Metabolism", "Endocrine"],
    ["Reproductive/Endocrine", "Female Reproductive System & Breast", "Reproductive"],
    ["Respiratory/Renal/Urinary", "Pulmonary & Critical Care", "Respiratory"],
    ["Respiratory/Renal/Urinary", "Renal, Urinary Systems & Electrolytes", "Renal"],
    ["Multisystem Processes & Disorders", "Microbiology—General Principles", "Microbiology"],
    ["Multisystem Processes & Disorders", "Pharmacology—General Principles", "Pharmacology"],
    ["Multisystem Processes & Disorders", "Pathology—General Principles", "Biochemistry"],
    ["Communication/Interpersonal Skills", "Social Sciences—Ethics/Legal/Professional", "Biostatistics and Ethics"],
  ];
  for (const [system, subsystem, expected] of cases) {
    assert.equal(normalize(system, subsystem), expected, `${system} / ${subsystem}`);
  }
});

test("canonical systems are preserved and Step 1 aliases do not leak to other exams", () => {
  assert.equal(normalize("Cardiovascular", "Cardiac physiology"), "Cardiovascular");
  assert.equal(canonicalAylaVimeoSystem({
    examTrackId: "usmle_step_2_ck",
    system: "Pulmonary",
    subsystem: "Pulmonary pathology",
    allowedSystems: ["Internal Medicine", "Surgery"],
  }), "");
});

test("every Vimeo approval path supplies the subsystem for composite normalization", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const calls = [...server.matchAll(/aylaVimeoCanonicalSystem\(\s*approved\.resource\.examTrackId,\s*approved\.resource\.system,\s*approved\.resource\.subsystem,\s*\)/g)];
  assert.equal(calls.length, 3);
});
