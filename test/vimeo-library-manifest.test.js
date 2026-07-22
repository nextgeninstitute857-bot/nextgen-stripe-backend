import test from "node:test";
import assert from "node:assert/strict";
import { buildVimeoLibraryManifest } from "../lib/vimeo-library-manifest.js";

test("Vimeo library metadata creates an exact AylaMed resource manifest", () => {
  const [row] = buildVimeoLibraryManifest([{
    uri: "/videos/123456",
    name: "Acute coronary syndrome",
    description: "system: Cardiology\ntopic: Ischemic heart disease\nplaylist: Cardiology core",
    duration: 725,
    link: "https://vimeo.com/123456/abc123",
    tags: [{ tag: "exam:usmle-step-1" }],
  }]);
  assert.equal(row.ready, true);
  assert.equal(row.resource.examTrackId, "usmle_step_1");
  assert.equal(row.resource.system, "Cardiology");
  assert.equal(row.resource.topic, "Ischemic heart disease");
  assert.equal(row.resource.vimeoId, "123456");
  assert.equal(row.resource.vimeoPrivacyHash, "abc123");
});

test("controlled title inference maps known systems and quarantines unknown ones", () => {
  const rows = buildVimeoLibraryManifest([
    { uri: "/videos/1", name: "Renal physiology overview", duration: 60 },
    { uri: "/videos/2", name: "Untitled lecture 17", duration: 60 },
  ], { examTrack: "usmle-step-1" });
  assert.equal(rows[0].ready, true);
  assert.equal(rows[0].resource.system, "Renal");
  assert.equal(rows[1].ready, false);
  assert.deepEqual(rows[1].missing, ["system"]);
});
