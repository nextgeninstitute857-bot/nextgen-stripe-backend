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
    ["Haematology and Oncology", "Clinical Practice", "Hematology"],
    ["Genetics", "Chromosomal Abnormalities", "Biochemistry"],
    ["Pulmonary", "Pulmonary pathology", "Respiratory"],
    ["General Pathology", "Neoplasia", "Biochemistry"],
    ["Dermatology", "Inflammatory skin disease", "Musculoskeletal"],
    ["Rheumatology and Orthopaedics", "Clinical Practice", "Musculoskeletal"],
    ["Female Reproductive and Breast", "Clinical Practice", "Reproductive"],
    ["Pulmonary and Ear, Nose and Throat", "Clinical Practice", "Respiratory"],
  ];
  for (const [system, subsystem, expected] of cases) {
    assert.equal(normalize(system, subsystem), expected, `${system} / ${subsystem}`);
  }
});

test("every system label in both reviewed Vimeo imports normalizes", () => {
  const cases = [
    ["Nervous System", "Neurology"],
    ["Cardiovascular", "Cardiovascular"],
    ["Microbiology", "Microbiology"],
    ["Endocrine", "Endocrine"],
    ["Biochemistry", "Biochemistry"],
    ["Pulmonary", "Respiratory"],
    ["Hematology and Oncology", "Hematology"],
    ["Renal", "Renal"],
    ["Gastrointestinal", "Gastrointestinal"],
    ["Reproductive", "Reproductive"],
    ["Musculoskeletal", "Musculoskeletal"],
    ["Genetics", "Biochemistry"],
    ["Immunology", "Immunology"],
    ["Behavioral Science", "Behavioral Science"],
    ["Biostatistics and Epidemiology", "Biostatistics and Ethics"],
    ["General Pathology", "Biochemistry"],
    ["Dermatology", "Musculoskeletal"],
    ["Embryology", "Biochemistry"],
    ["Ethics and Communication", "Biostatistics and Ethics"],
    ["Psychiatry", "Behavioral Science"],
    ["Cell Biology", "Biochemistry"],
    ["Pharmacology", "Pharmacology"],
  ];
  for (const [system, expected] of cases) {
    assert.equal(normalize(system), expected, system);
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

test("global Vimeo publication preflights the full catalogue before storing resources", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const start = server.indexOf("function aylaPrepareGlobalVimeoPublication");
  const end = server.indexOf('app.get("/api/ayla/admin/resources/vimeo-catalog/global-publication"', start);
  const helper = server.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(helper, /for \(const draft of drafts\)/);
  assert.match(helper, /failures\.push/);
  assert.match(helper, /AYLAMED_GLOBAL_VIMEO_PREFLIGHT_FAILED/);

  const routeStart = server.indexOf('app.post("/api/ayla/admin/resources/vimeo-catalog/global-publication"');
  const routeEnd = server.indexOf('function aylaGlobalSharedResourcePublicationState', routeStart);
  const route = server.slice(routeStart, routeEnd);
  assert.ok(routeStart > 0 && routeEnd > routeStart);
  assert.ok(route.indexOf("aylaPrepareGlobalVimeoPublication") < route.indexOf("aylaV190StoreImportedResource"));
});
