import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAylaNclexSessionVariant,
  aylaNclexBankVariant,
  aylaNclexVariantLabel,
  filterAylaNclexBanksForStudent,
  normalizeAylaNclexVariant,
  requireAylaNclexVariant,
} from "../lib/aylamed-nclex-variant.js";

const BANKS = [
  { id: "uw-rn", name: "UWorld NCLEX-RN", question_count: 1563 },
  { id: "bv-rn", collection_key: "boardvitals-nclex-rn", question_count: 2956 },
  { id: "uw-pn", title: "UWorld NCLEX-PN 2026", question_count: 823 },
  { id: "bv-pn", source_namespace: "boardvitals_nclex_pn", question_count: 1523 },
  { id: "unknown", name: "Unclassified Nursing Bank", question_count: 10 },
];

test("normalizes RN and PN aliases and preserves student-facing labels", () => {
  assert.equal(normalizeAylaNclexVariant("NCLEX-RN"), "nclex_rn");
  assert.equal(normalizeAylaNclexVariant("registered nurse"), "nclex_rn");
  assert.equal(normalizeAylaNclexVariant("LPN"), "nclex_pn");
  assert.equal(normalizeAylaNclexVariant("unknown"), "");
  assert.equal(aylaNclexVariantLabel("pn"), "NCLEX-PN");
});

test("classifies NCLEX bank identities without treating unknown banks as safe", () => {
  assert.equal(aylaNclexBankVariant(BANKS[0]), "nclex_rn");
  assert.equal(aylaNclexBankVariant(BANKS[3]), "nclex_pn");
  assert.equal(aylaNclexBankVariant(BANKS[4]), "");
});

test("RN and PN students receive disjoint bank collections", () => {
  const rn = filterAylaNclexBanksForStudent(BANKS, { examVariant: "nclex_rn" }, "nclex");
  const pn = filterAylaNclexBanksForStudent(BANKS, { nclex_type: "pn" }, "nclex");
  assert.deepEqual(rn.map((bank) => bank.id), ["uw-rn", "bv-rn"]);
  assert.deepEqual(pn.map((bank) => bank.id), ["uw-pn", "bv-pn"]);
  assert.equal(rn.reduce((sum, bank) => sum + bank.question_count, 0), 4519);
  assert.equal(pn.reduce((sum, bank) => sum + bank.question_count, 0), 2346);
  assert.equal(rn.some((bank) => pn.some((other) => other.id === bank.id)), false);
});

test("NCLEX access fails closed when the profile has no program choice", () => {
  assert.throws(
    () => requireAylaNclexVariant({}, "nclex"),
    (error) => error.statusCode === 409 && error.code === "NCLEX_VARIANT_REQUIRED",
  );
});

test("sessions are bound to the student's immutable NCLEX program", () => {
  assert.equal(
    assertAylaNclexSessionVariant(
      { examTrackId: "nclex", examVariant: "nclex_rn" },
      { examTrack: "nclex", nclexVariant: "nclex_rn" },
    ),
    "nclex_rn",
  );
  assert.throws(
    () => assertAylaNclexSessionVariant(
      { examTrackId: "nclex", examVariant: "nclex_rn" },
      { examTrack: "nclex", nclexVariant: "nclex_pn" },
    ),
    (error) => error.statusCode === 403 && error.code === "NCLEX_VARIANT_MISMATCH",
  );
  assert.throws(
    () => assertAylaNclexSessionVariant(
      { examTrackId: "nclex", examVariant: "nclex_rn" },
      { examTrack: "nclex" },
    ),
    (error) => error.statusCode === 409 && error.code === "LEGACY_NCLEX_SESSION_RESTART_REQUIRED",
  );
});
