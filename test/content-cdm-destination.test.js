import assert from "node:assert/strict";
import test from "node:test";
import { contentCollectionDestinationCompatibility } from "../lib/content-registry-postgres.js";

test("legacy CDM collections are isolated from ordinary QBank scoring destinations", () => {
  assert.deepEqual(contentCollectionDestinationCompatibility({
    itemFormats: ["cdm_self_rating_case"],
    destinations: ["aylamed_cdm", "aylamed_roadmap"],
  }), []);
  assert.deepEqual(contentCollectionDestinationCompatibility({
    itemFormats: ["cdm_self_rating_case"],
    destinations: ["aylamed_cdm", "aylamed_qbank"],
  }), ["cdm_incompatible_destination"]);
});

test("ordinary SBA collections cannot be enabled in the CDM player", () => {
  assert.deepEqual(contentCollectionDestinationCompatibility({
    itemFormats: ["single_best_answer"],
    destinations: ["aylamed_cdm"],
  }), ["cdm_destination_requires_cdm_items"]);
});

test("CDM approval requires the dedicated delivery destination", () => {
  assert.deepEqual(contentCollectionDestinationCompatibility({
    itemFormats: ["cdm_self_rating_case"],
    destinations: ["aylamed_roadmap"],
  }), ["cdm_delivery_destination_required"]);
});
