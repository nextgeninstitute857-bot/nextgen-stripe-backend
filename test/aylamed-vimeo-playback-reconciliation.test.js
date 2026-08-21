import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  applyAylaVimeoPlaybackConfig,
  aylaVimeoPlaybackDomainFingerprint,
  aylaVimeoPlaybackEligible,
  aylaVimeoProviderId,
  selectAylaVimeoPlaybackCandidates,
} from "../lib/aylamed-vimeo-playback-reconciliation.js";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

function activeVideo(overrides = {}) {
  return {
    id: "video-1",
    type: "vimeo_video",
    examTrackId: "usmle_step_2_ck",
    vimeoId: "123456789",
    vimeoEmbedUrl: "https://player.vimeo.com/video/123456789?h=oldhash",
    approved: true,
    status: "active",
    system: "Medicine",
    topic: "Chest pain",
    scoringAllowed: true,
    ...overrides,
  };
}

test("approved videos are selected for domain repair without changing learning metadata", () => {
  const fingerprint = aylaVimeoPlaybackDomainFingerprint(["aylamedapp.com"], "build-1");
  const source = activeVideo();
  assert.equal(aylaVimeoProviderId(source), "123456789");
  assert.equal(aylaVimeoPlaybackEligible(source), true);
  assert.deepEqual(selectAylaVimeoPlaybackCandidates({
    resources: [
      activeVideo({ id: "step1", examTrackId: "usmle_step_1", vimeoId: "999999999" }),
      source,
      activeVideo({ id: "disabled", vimeoId: "111111111", status: "disabled" }),
      activeVideo({ id: "done", vimeoId: "222222222", vimeoEmbedDomainFingerprint: fingerprint }),
    ],
    fingerprint,
    limit: 10,
  }), ["123456789", "999999999"]);

  const updated = applyAylaVimeoPlaybackConfig(source, {
    video_id: "123456789",
    embed_url: "https://player.vimeo.com/video/123456789?h=newhash",
    privacy_embed: "whitelist",
  }, {
    fingerprint,
    domains: ["aylamedapp.com"],
    updatedAt: "2026-08-21T12:00:00.000Z",
  });
  assert.equal(updated.vimeoPrivacyHash, "newhash");
  assert.equal(updated.vimeoEmbedPrivacyMode, "whitelist");
  assert.equal(updated.vimeoEmbedDomainFingerprint, fingerprint);
  assert.equal(updated.system, source.system);
  assert.equal(updated.topic, source.topic);
  assert.equal(updated.scoringAllowed, source.scoringAllowed);
  assert.equal(updated.approved, source.approved);

  const fallback = applyAylaVimeoPlaybackConfig(source, {
    embed_url: "https://player.vimeo.com/video/123456789",
    privacy_embed: "public",
    privacy_view: "disable",
    allowed_domains: [],
    fallback_mode: "secure_embed_only_public",
  }, {
    fingerprint,
    domains: ["aylamedapp.com"],
    updatedAt: "2026-08-21T12:00:00.000Z",
  });
  assert.deepEqual(fallback.vimeoEmbedDomains, []);
  assert.deepEqual(fallback.vimeoEmbedRequestedDomains, ["aylamedapp.com"]);
  assert.equal(fallback.vimeoEmbedPrivacyMode, "public");
  assert.equal(fallback.vimeoEmbedFallbackMode, "secure_embed_only_public");
});

test("failed videos honor retry backoff so one provider error cannot block later batches", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const fingerprint = aylaVimeoPlaybackDomainFingerprint(["aylamedapp.com"], "build-1");
  const deferred = activeVideo({
    vimeoEmbedReconcileNextAttemptAt: "2026-08-21T13:00:00.000Z",
    vimeoEmbedReconcileFingerprint: fingerprint,
  });
  assert.deepEqual(selectAylaVimeoPlaybackCandidates({ resources: [deferred], fingerprint, now }), []);
  assert.deepEqual(selectAylaVimeoPlaybackCandidates({
    resources: [deferred],
    fingerprint: aylaVimeoPlaybackDomainFingerprint(["aylamedapp.com"], "build-2"),
    now,
  }), ["123456789"]);
  assert.deepEqual(selectAylaVimeoPlaybackCandidates({
    resources: [deferred],
    fingerprint,
    now: Date.parse("2026-08-21T14:00:00.000Z"),
  }), ["123456789"]);
});

test("server wires global playback reconciliation to startup, health and guarded admin controls", () => {
  assert.match(server, /const AYLA_VIMEO_PLAYBACK_BUILD = "v268-secure-embed-only-playback"/);
  assert.match(server, /allowEmbedOnlyPublicFallback: true/);
  assert.match(server, /AYLA_VIMEO_PLAYBACK_BATCH_SIZE \|\| 100/);
  assert.match(server, /AYLA_VIMEO_PLAYBACK_CONCURRENCY \|\| 5/);
  assert.match(server, /async function aylaReconcileVimeoPlaybackBatch/);
  assert.match(server, /ngStartAylaVimeoPlaybackReconciliationScheduler\(\);/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/resources\/vimeo-playback\/status"/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/resources\/vimeo-playback\/reconcile"/);
  assert.match(server, /await aylaRequireAdmin\(req\)/);
  assert.match(server, /aylamed_vimeo_playback_reconciliation: aylaVimeoPlaybackReconciliationState/);
});
