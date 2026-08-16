import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { aylaPublicationGroupForResource } from "../lib/aylamed-exam-publication.js";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("current MCCQE retires the legacy CDM student surface", () => {
  assert.match(server, /const AYLA_CURRENT_MCCQE_CDM_ENABLED = false;/);
  assert.match(server, /app\.use\("\/api\/ayla\/cdm"[\s\S]{0,300}\b410\b/);
  assert.match(server, /Clinical Decision Making cases were removed from the current MCCQE format/);
  assert.match(server, /assignment_mix:\s*\{[^}]*cdm_cases:\s*false/);
});

test("legacy CDM programs cannot reappear in publication controls", () => {
  assert.equal(aylaPublicationGroupForResource({
    id: "legacy-cdm",
    type: "cdm_program",
    exam_track_id: "mccqe",
  }), null);
});
