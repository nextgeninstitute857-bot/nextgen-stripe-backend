import test from "node:test";
import assert from "node:assert/strict";
import { aylaStudentBankName } from "../lib/aylamed-bank-names.js";

test("known QBank brands use stable student-facing names", () => {
  assert.equal(aylaStudentBankName({ title: "Uworld Step 1: uworldstep1-2026-march" }), "UWorld");
  assert.equal(aylaStudentBankName({ title: "AMBOSS USMLE Step 1 2025: ambossqb-usmle-step-12025-db" }), "AMBOSS");
  assert.equal(aylaStudentBankName({ title: "CanadaQBank MCCQE 2025" }), "CanadaQBank");
  assert.equal(aylaStudentBankName({ title: "ACE QBank 2025" }), "ACE QBank");
  assert.equal(aylaStudentBankName({ title: "amedex-amc-bank-2026.db" }), "Amedex");
  assert.equal(aylaStudentBankName({ collection_key: "mplusx_amc_2025" }), "MPlusX");
});

test("MCCQE supplement and NCLEX variants remain unambiguous", () => {
  assert.equal(aylaStudentBankName({ title: "UWorld March import" }, { examTrack: "mccqe", supplemental: true }), "UWorld Step 2 CK");
  assert.equal(aylaStudentBankName({ title: "UWorld NCLEX-PN 2026" }, { examTrack: "nclex" }), "UWorld NCLEX-PN");
  assert.equal(aylaStudentBankName({ title: "BoardVitals NCLEX-RN" }, { examTrack: "nclex" }), "BoardVitals NCLEX-RN");
});

test("unknown banks still remove raw import suffixes and filenames", () => {
  assert.equal(aylaStudentBankName({ title: "Clinical Master Bank: clinical-master-2026-db" }), "Clinical Master Bank");
  assert.equal(aylaStudentBankName({ title: "Local_Bank.db" }), "Local Bank");
});
