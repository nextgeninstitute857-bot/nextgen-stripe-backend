import test from "node:test";
import assert from "node:assert/strict";
import { canonicalAylaAdaptiveSystem } from "../lib/aylamed-adaptive-system-normalization.js";

const normalize = (examTrackId, system, subsystem, allowedSystems) => canonicalAylaAdaptiveSystem({
  examTrackId,
  system,
  subsystem,
  allowedSystems,
});

test("MCCQE source disciplines normalize to the student curriculum", () => {
  const allowed = ["Family Medicine", "Internal Medicine", "Surgery", "Pediatrics", "Obstetrics and Gynecology", "Psychiatry", "Emergency Medicine", "Preventive Care", "Ethics and Communication"];
  assert.equal(normalize("mccqe", "mccqe:psychiatry_and_behavioural_health", "", allowed), "Psychiatry");
  assert.equal(normalize("mccqe", "Internal and Family Medicine", "Assessment and Management", allowed), "Family Medicine");
  assert.equal(normalize("mccqe", "Paediatrics", "Acute Care", allowed), "Pediatrics");
  assert.equal(normalize("mccqe", "Preventive Care, Ethics and Communication", "Health Promotion", allowed), "Preventive Care");
});

test("clinical source systems normalize across Step 2, Step 3, PLAB and AMC", () => {
  assert.equal(normalize("usmle_step_2_ck", "Cardiovascular", "Medicine", ["Internal Medicine"]), "Internal Medicine");
  assert.equal(normalize("usmle_step_3", "Pregnancy, Childbirth and Puerperium", "Obstetrics and Gynaecology", ["Obstetrics and Gynecology"]), "Obstetrics and Gynecology");
  assert.equal(normalize("plab", "Psychiatry", "Clinical Capability", ["Psychiatry"]), "Psychiatry");
  assert.equal(normalize("amc", "Paediatrics", "Child and Adolescent Health", ["Child Health"]), "Child Health");
});

test("NCLEX client-need labels normalize without leaking raw namespaces", () => {
  const allowed = ["Management of Care", "Safety and Infection Control", "Pharmacological Therapies", "Prioritization and Delegation"];
  assert.equal(normalize("nclex", "nclex:safety_and_infection_control", "Client Needs", allowed), "Safety and Infection Control");
  assert.equal(normalize("nclex", "Parenteral Therapies", "", allowed), "Pharmacological Therapies");
});

