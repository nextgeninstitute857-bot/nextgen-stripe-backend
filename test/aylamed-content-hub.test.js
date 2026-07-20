import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aylaContentHubAssignmentProgress,
  aylaContentHubEmbedUrl,
  buildAylaContentHubCatalog,
  mergeAylaContentHubProgress,
  mergeAylaContentHubProgressCollection,
  normalizeAylaContentHubVideo,
  sanitizeAylaContentHubVideo,
  selectAylaRoadmapVideo,
} from "../lib/aylamed-content-hub.js";

function legacyVideo(overrides = {}) {
  return {
    id: "legacy-video-1",
    type: "vimeo_video",
    title: "Cardiac murmurs",
    examTrackId: "usmle_step_1",
    system: "Cardiovascular",
    topic: "Murmurs",
    vimeoUrl: "https://vimeo.com/123456789/privatehash",
    authorizationStatus: "licensed",
    verificationStatus: "admin_verified",
    approved: true,
    status: "active",
    ...overrides,
  };
}

function registryVideo(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    resource_id: "registry-video:11111111-1111-4111-8111-111111111111",
    source_type: "registry",
    title: "Cardiac murmurs registry lesson",
    exam_track: "usmle-step-1",
    system_key: "Cardiovascular",
    topic_key: "Murmurs",
    provider_id: "123456789",
    embed_url: "https://player.vimeo.com/video/123456789?h=privatehash",
    authorization_status: "approved_collection",
    verification_status: "approved_content_registry",
    mapping_status: "approved_registry_taxonomy",
    delivery_destinations: ["aylamed_content_hub", "aylamed_roadmap"],
    approved: true,
    status: "draft_processing",
    ...overrides,
  };
}

test("Vimeo inputs become embedded-player URLs and never require an outbound public link", () => {
  assert.equal(aylaContentHubEmbedUrl(legacyVideo()), "https://player.vimeo.com/video/123456789?h=privatehash");
  const normalized = normalizeAylaContentHubVideo(legacyVideo(), { examTrack: "USMLE Step 1" });
  const student = sanitizeAylaContentHubVideo(normalized);
  assert.equal(student.embed_url, "https://player.vimeo.com/video/123456789?h=privatehash");
  assert.equal("vimeoUrl" in student, false);
  assert.equal("provider_id" in student, false);
  assert.equal("provider_uri" in student, false);
});

test("Content Hub fails closed for another exam, unverified rights, and non-Vimeo playback", () => {
  assert.equal(normalizeAylaContentHubVideo(legacyVideo(), { examTrack: "nclex" }), null);
  assert.equal(normalizeAylaContentHubVideo(legacyVideo({ authorizationStatus: "pending_review" })), null);
  assert.equal(normalizeAylaContentHubVideo(legacyVideo({ vimeoUrl: "https://videos.example.com/123", vimeoId: "" })), null);
  assert.equal(normalizeAylaContentHubVideo(legacyVideo({ vimeoUrl: "https://evilvimeo.com/123", vimeoId: "" })), null);
  assert.equal(normalizeAylaContentHubVideo(legacyVideo({ status: "disabled" })), null);
});

test("duplicate provider videos collapse into deterministic playlist entries", () => {
  const catalog = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos: [legacyVideo({ sourceLabelVisible: false }), registryVideo({ source_label: "Source" })],
  });
  assert.equal(catalog.total, 1);
  assert.equal(catalog.playlists.length, 1);
  assert.equal(catalog.playlists[0].title, "Cardiovascular");
  assert.deepEqual(catalog.playlists[0].topics, ["Murmurs"]);
  assert.equal(catalog.videos[0].source_type, "registry");
  assert.equal(catalog.videos[0].source_label, "Source");
});

test("roadmap-only registry delivery is visible only while linked to the student's assignment", () => {
  const video = registryVideo({ delivery_destinations: ["aylamed_roadmap"] });
  const hidden = buildAylaContentHubCatalog({ examTrack: "usmle_step_1", videos: [video] });
  assert.equal(hidden.total, 0);

  const assigned = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos: [video],
    assignments: [{ id: "assignment-1", category: "video", status: "pending", resourceIds: [video.resource_id], scheduledDate: "2026-07-19" }],
  });
  assert.equal(assigned.total, 1);
  assert.equal(assigned.videos[0].roadmap_assignment.id, "assignment-1");
});

test("catalog filters, resume state, and pagination stay inside one exam", () => {
  const videos = [
    legacyVideo(),
    legacyVideo({ id: "legacy-video-2", vimeoId: "222", vimeoUrl: "", title: "Renal clearance", system: "Renal", topic: "Clearance" }),
    legacyVideo({ id: "legacy-video-3", vimeoId: "333", vimeoUrl: "", title: "NCLEX safety", examTrackId: "nclex", system: "Safety", topic: "Isolation" }),
  ];
  const catalog = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos,
    progressRows: [{ id: "p1", resourceId: "legacy-video-2", watchedPercent: 42, lastPositionSeconds: 310, updatedAt: "2026-07-19T10:00:00.000Z" }],
    filters: { system: "Renal", search: "clearance" },
    limit: 1,
  });
  assert.equal(catalog.total, 1);
  assert.equal(catalog.videos[0].id, "legacy-video-2");
  assert.equal(catalog.continue_watching[0].progress.watched_percent, 42);
  assert.equal(catalog.exam_track_id, "usmle_step_1");
  assert.equal(catalog.has_more, false);
});

test("roadmap assignment prefers an exact verified focus and never reassigns completed video", () => {
  const exact = legacyVideo({ id: "exact", vimeoId: "444", vimeoUrl: "", deliveryDestinations: ["aylamed_roadmap"] });
  const systemWide = legacyVideo({ id: "system", vimeoId: "555", vimeoUrl: "", topic: "Cardiac physiology", deliveryDestinations: ["aylamed_roadmap"] });
  const first = selectAylaRoadmapVideo({
    examTrack: "usmle_step_1",
    videos: [systemWide, exact],
    focusSystem: "Cardiovascular",
    focusTopic: "Murmurs",
    progressRows: [{ resourceId: "exact", watchedPercent: 35 }],
  });
  assert.equal(first.video.id, "exact");
  assert.equal(first.match_level, "exact_topic");
  assert.equal(first.resumed, true);

  const next = selectAylaRoadmapVideo({
    examTrack: "usmle_step_1",
    videos: [systemWide, exact],
    focusSystem: "Cardiovascular",
    focusTopic: "Murmurs",
    progressRows: [{ resourceId: "exact", watchedPercent: 95, completed: true }],
  });
  assert.equal(next.video.id, "system");
  assert.equal(next.match_level, "system");
});

test("video progress is monotonic and completion requires the verified 90 percent threshold", () => {
  const current = { id: "p1", watchedPercent: 65, lastPositionSeconds: 420, completed: false, updatedAt: "2026-07-19T10:00:00.000Z" };
  const stale = mergeAylaContentHubProgress(current, { watchedPercent: 20, lastPositionSeconds: 100, completed: true }, new Date("2026-07-19T10:01:00.000Z"));
  assert.equal(stale.watchedPercent, 65);
  assert.equal(stale.lastPositionSeconds, 420);
  assert.equal(stale.completed, false);
  const complete = mergeAylaContentHubProgress(stale, { watchedPercent: 91, lastPositionSeconds: 600 }, new Date("2026-07-19T10:02:00.000Z"));
  assert.equal(complete.completed, true);
  assert.equal(complete.watchedPercent, 91);
});

test("a multi-video roadmap assignment completes only after every video reaches 90 percent", () => {
  const assignment = { id: "assignment-1", resourceIds: ["video-1", "video-2"] };
  const partial = aylaContentHubAssignmentProgress(assignment, [
    { assignmentId: "assignment-1", resourceId: "video-1", watchedPercent: 100 },
    { assignmentId: "assignment-1", resourceId: "video-2", watchedPercent: 40 },
  ]);
  assert.equal(partial.completed, false);
  assert.equal(partial.watched_percent, 70);

  const complete = aylaContentHubAssignmentProgress(assignment, [
    { assignmentId: "assignment-1", resourceId: "video-1", watchedPercent: 100 },
    { assignmentId: "assignment-1", resourceId: "canonical-video-2", aliasResourceIds: ["video-2"], watchedPercent: 90 },
  ]);
  assert.equal(complete.completed, true);
  assert.equal(complete.watched_percent, 95);
});

test("stale general database writes cannot erase newer Content Hub progress", () => {
  const latest = {
    p1: { id: "p1", studentId: "s1", resourceId: "v1", watchedPercent: 75, lastPositionSeconds: 500, updatedAt: "2026-07-19T10:05:00.000Z" },
    p2: { id: "p2", studentId: "s1", resourceId: "v2", watchedPercent: 10, lastPositionSeconds: 60, updatedAt: "2026-07-19T10:04:00.000Z" },
  };
  const incoming = {
    p1: { id: "p1", studentId: "s1", resourceId: "v1", watchedPercent: 15, lastPositionSeconds: 90, updatedAt: "2026-07-19T10:00:00.000Z" },
  };
  const merged = mergeAylaContentHubProgressCollection(latest, incoming);
  assert.equal(merged.p1.watchedPercent, 75);
  assert.equal(merged.p1.lastPositionSeconds, 500);
  assert.equal(merged.p2.watchedPercent, 10);
});

test("server and registry wire one entitlement-guarded Content Hub into the existing roadmap", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const postgres = fs.readFileSync(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/content-hub"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/content-hub\/videos\/:videoId"/);
  assert.match(server, /app\.post\("\/api\/ayla\/students\/:studentId\/content-hub\/videos\/:videoId\/progress", aylaV210SaveVideoProgress\)/);
  assert.match(server, /app\.post\("\/api\/ayla\/students\/:studentId\/video-progress", aylaV210SaveVideoProgress\)/);
  assert.match(server, /aylaV189RequireStudent\(req, req\.params\.studentId, "content_hub"\)/);
  assert.match(server, /mutateAylaDb\(async \(db\) =>[\s\S]*?aylaDashboardEntitlement\(db, aylaSanitizeUser\(rawUser\), student, "content_hub"\)/);
  assert.match(server, /function aylaV189BuildDailyPlan[\s\S]*?selectAylaRoadmapVideo\(/);
  assert.match(postgres, /'aylamed_content_hub'/);
  assert.match(postgres, /export async function listContentHubVideos/);
  assert.match(postgres, /q\.status='approved' AND c\.status='approved' AND d\.enabled=TRUE/);
  assert.match(postgres, /d\.destination=ANY\(\$2::text\[\]\)/);
  const deliveryQuery = postgres.slice(postgres.indexOf("export async function listContentHubVideos"), postgres.indexOf("export async function getContentQbankCatalog"));
  assert.match(deliveryQuery, /SELECT va\.id,q\.exam_track/);
  assert.match(deliveryQuery, /WHERE q\.exam_track=ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(deliveryQuery, /va\.exam_track=ANY/);
});
