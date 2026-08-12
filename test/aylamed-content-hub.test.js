import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aylaContentHubAssignmentProgress,
  aylaContentHubEmbedUrl,
  aylaContentHubTaxonomyDefinition,
  buildAylaContentHubCatalog,
  mergeAylaContentHubProgress,
  mergeAylaContentHubProgressCollection,
  normalizeAylaContentHubVideo,
  normalizeAylaContentHubVideos,
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
    subsystem_key: "Valvular disease",
    topic_key: "Murmurs",
    subtopic_key: "Aortic stenosis",
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

test("Step 2 videos can appear in MCCQE only as non-scoring supplemental content", () => {
  const [video] = normalizeAylaContentHubVideos([{
    id: "step2-video-1",
    sourceType: "registry",
    examTrackId: "usmle_step_2_ck",
    supplementalForExamTrackId: "mccqe",
    vimeoId: "123456789",
    title: "Chest pain triage",
    system: "Cardiovascular",
    approved: true,
    authorizationStatus: "approved_collection",
  }], { examTrack: "mccqe" });
  const studentVideo = sanitizeAylaContentHubVideo(video);
  assert.equal(studentVideo.exam_track_id, "mccqe");
  assert.equal(studentVideo.source_exam_track_id, "usmle_step_2_ck");
  assert.equal(studentVideo.supplemental, true);
  assert.equal(studentVideo.scoring_allowed, false);
  assert.equal(studentVideo.supplemental_label, "Step 2 CK Supplemental");
});

test("raw media filenames never become student-facing video titles", () => {
  const mapped = normalizeAylaContentHubVideo(registryVideo({
    title: "iMD/17407.mp4",
    original_name: "iMD/17407.mp4",
    topic_key: "Acute coronary syndrome",
  }));
  assert.equal(mapped.title, "Acute coronary syndrome");

  const fallback = normalizeAylaContentHubVideo(registryVideo({
    title: "iMD/17407.mp4",
    original_name: "iMD/17407.mp4",
    topic_key: "",
    subtopic_key: "",
  }));
  assert.equal(fallback.title, "Focused video review");
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
  assert.deepEqual(catalog.playlists[0].subsystems, ["Valvular disease"]);
  assert.deepEqual(catalog.playlists[0].topics, ["Murmurs"]);
  assert.equal(catalog.videos[0].source_type, "registry");
  assert.equal(catalog.videos[0].source_label, "Source");
});

test("Content Hub exposes a complete exam-aware hierarchy without changing compatibility field names", () => {
  const catalog = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos: [
      legacyVideo({
        id: "valve-video",
        vimeoId: "4441",
        vimeoUrl: "",
        subsystem: "Valvular disease",
        topic: "Cardiac murmurs",
        subtopic: "Aortic stenosis",
      }),
      legacyVideo({
        id: "ischemia-video",
        vimeoId: "4442",
        vimeoUrl: "",
        subsystem: "Ischemic heart disease",
        topic: "Acute coronary syndrome",
        subtopic: "Myocardial infarction",
      }),
    ],
  });
  assert.equal(catalog.taxonomy.labels.system, "Organ system or foundational domain");
  assert.deepEqual(catalog.taxonomy.primary_navigation, ["exam", "system", "subsystem", "topic", "subtopic"]);
  assert.equal(catalog.hierarchy.length, 1);
  assert.equal(catalog.hierarchy[0].title, "Cardiovascular");
  assert.equal(catalog.hierarchy[0].video_count, 2);
  assert.deepEqual(
    catalog.hierarchy[0].subsystems.map((row) => row.title),
    ["Ischemic heart disease", "Valvular disease"],
  );
  assert.deepEqual(
    catalog.videos.find((row) => row.id === "valve-video").hierarchy_path,
    ["Cardiovascular", "Valvular disease", "Cardiac murmurs", "Aortic stenosis"],
  );

  const filtered = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos: catalog.videos.map((row) => ({
      ...row,
      examTrackId: "usmle_step_1",
      vimeoEmbedUrl: row.embed_url,
      authorizationStatus: "licensed",
      approved: true,
      status: "active",
    })),
    filters: { subsystem: "Valvular disease", subtopic: "Aortic stenosis" },
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.videos[0].id, "valve-video");
});

test("the visible Unclassified subsystem node remains selectable", () => {
  const catalog = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos: [legacyVideo({ subsystem: "" })],
    filters: { subsystem: "unclassified" },
  });
  assert.equal(catalog.total, 1);
  assert.equal(catalog.hierarchy[0].subsystems[0].key, "unclassified");
  assert.equal(catalog.videos[0].id, "legacy-video-1");
});

test("exam-specific navigation labels keep non-USMLE blueprints recognizable", () => {
  assert.equal(aylaContentHubTaxonomyDefinition("plab").labels.system, "Area of clinical practice");
  assert.equal(aylaContentHubTaxonomyDefinition("mccqe").blueprint_axes.includes("physician_activity"), true);
  assert.equal(aylaContentHubTaxonomyDefinition("nclex").labels.system, "Client Need");
  assert.equal(aylaContentHubTaxonomyDefinition("nclex").labels.subsystem, "Subcategory");
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

test("roadmap assignment respects subsystem boundaries before topic scoring", () => {
  const valve = legacyVideo({
    id: "valve",
    vimeoId: "556",
    vimeoUrl: "",
    subsystem: "Valvular disease",
    topic: "Aortic stenosis",
    deliveryDestinations: ["aylamed_roadmap"],
  });
  const ischemia = legacyVideo({
    id: "ischemia",
    vimeoId: "557",
    vimeoUrl: "",
    subsystem: "Ischemic heart disease",
    topic: "Aortic stenosis",
    deliveryDestinations: ["aylamed_roadmap"],
  });
  const selected = selectAylaRoadmapVideo({
    examTrack: "usmle_step_1",
    videos: [ischemia, valve],
    focusSystem: "Cardiovascular",
    focusSubsystem: "Valvular disease",
    focusTopic: "Aortic stenosis",
  });
  assert.equal(selected.video.id, "valve");
  assert.equal(selected.match_level, "exact_topic");
});

test("roadmap and catalog filters recognize approved medical and QBank topic aliases", () => {
  const aliased = legacyVideo({
    id: "aliased",
    vimeoId: "777",
    vimeoUrl: "",
    topic: "Ischemic heart disease",
    topicAliases: ["Acute myocardial infarction", "STEMI"],
    qbankTaxonomy: { topicKey: "Acute coronary syndrome", subtopicKey: "Myocardial infarction" },
    deliveryDestinations: ["aylamed_content_hub", "aylamed_roadmap"],
  });
  const selected = selectAylaRoadmapVideo({
    examTrack: "usmle_step_1",
    videos: [aliased],
    focusSystem: "Cardiovascular",
    focusTopic: "Acute myocardial infarction",
  });
  assert.equal(selected.video.id, "aliased");
  assert.equal(selected.match_level, "exact_topic");

  const catalog = buildAylaContentHubCatalog({
    examTrack: "usmle_step_1",
    videos: [aliased],
    filters: { topic: "Acute coronary syndrome" },
  });
  assert.equal(catalog.total, 1);
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
  assert.match(server, /focusSubsystem,/);
  assert.match(server, /subsystem: req\.query\.subsystem \|\| req\.query\.subsystem_key/);
  assert.match(server, /const pageSize = 500;[\s\S]*?while \(true\)[\s\S]*?offset: sourceRows\.length/);
  assert.match(server, /listAylaExamSupplements\(examTrack\)[\s\S]*?supplementalForExamTrackId/);
  assert.doesNotMatch(server, /content_registry_video_limit_reached/);
  assert.match(postgres, /'aylamed_content_hub'/);
  assert.match(postgres, /export async function listContentHubVideos/);
  assert.match(postgres, /q\.status='approved' AND c\.status='approved' AND d\.enabled=TRUE/);
  assert.match(postgres, /d\.destination=ANY\(\$2::text\[\]\)/);
  const deliveryQuery = postgres.slice(postgres.indexOf("export async function listContentHubVideos"), postgres.indexOf("export async function getContentQbankCatalog"));
  assert.match(deliveryQuery, /SELECT va\.id,q\.exam_track/);
  assert.match(deliveryQuery, /WHERE q\.exam_track=ANY\(\$1::text\[\]\)/);
  assert.match(deliveryQuery, /q\.taxonomy->>'subsystem_key'/);
  assert.match(deliveryQuery, /primary_subsystem_key AS subsystem_key/);
  assert.doesNotMatch(deliveryQuery, /va\.exam_track=ANY/);
});
