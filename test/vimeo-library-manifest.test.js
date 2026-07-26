import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  approveVimeoCatalogDraft,
  buildVimeoLibraryManifest,
  buildVimeoTopicClassificationRequest,
  extractVimeoWebSearchEvidence,
  fetchVimeoFolder,
  fetchVimeoFolders,
  fetchVimeoLibrary,
  normalizeVimeoFolderId,
  normalizeVimeoTopicClassification,
  rankVimeoQbankTaxonomyCandidates,
  upsertVimeoCatalogDraft,
  vimeoCatalogSummary,
} from "../lib/vimeo-library-manifest.js";

function vimeoVideo(overrides = {}) {
  return {
    uri: "/videos/123456",
    name: "Acute coronary syndrome",
    description: "system: Cardiovascular\ntopic: Ischemic heart disease\nplaylist: Cardiology core",
    duration: 725,
    link: "https://vimeo.com/123456/abc123",
    tags: [{ tag: "exam:usmle-step-1" }],
    created_time: "2026-01-01T00:00:00.000Z",
    modified_time: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function taxonomyRows() {
  return [
    {
      system_key: "Cardiovascular",
      subsystem_key: "Ischemic heart disease",
      topic_key: "Acute coronary syndrome",
      subtopic_key: "Myocardial infarction",
      question_count: 84,
    },
    {
      system_key: "Cardiovascular",
      subsystem_key: "Valvular disease",
      topic_key: "Cardiac murmurs",
      subtopic_key: "Aortic stenosis",
      question_count: 42,
    },
  ];
}

function catalogDraft() {
  const [manifest] = buildVimeoLibraryManifest([vimeoVideo()], {
    examTrack: "usmle-step-1",
    allowedSystems: ["Cardiovascular", "Renal"],
  });
  return upsertVimeoCatalogDraft(manifest, {}, {
    now: new Date("2026-07-25T10:00:00.000Z"),
    actorId: "admin-1",
    actorEmail: "owner@example.com",
  }).draft;
}

function successfulClassification(draft = catalogDraft(), overrides = {}) {
  const request = buildVimeoTopicClassificationRequest(draft, {
    examTrackLabel: "USMLE Step 1",
    allowedSystems: ["Cardiovascular", "Renal"],
    taxonomyRows: taxonomyRows(),
  });
  const proposal = {
    interpreted_title: "Acute coronary syndrome",
    medical_system: "Cardiovascular",
    medical_subsystem: "Ischemic heart disease",
    canonical_topic: "Acute coronary syndrome",
    subtopic: "Myocardial infarction",
    topic_aliases: ["ACS", "Acute myocardial ischemia"],
    qbank_topic_ref: request.candidates[0].ref,
    qbank_match_kind: "exact_title",
    plain_language_summary: "A lecture about sudden loss of blood flow to heart muscle.",
    classification_reason: "Authoritative sources use this term for unstable angina and myocardial infarction.",
    confidence_percent: 96,
    ambiguity_flags: [],
    alternative_mappings: [],
    ...overrides,
  };
  const evidence = {
    performed: true,
    queries: ["Acute coronary syndrome medical topic"],
    sources: [{
      url: "https://www.ncbi.nlm.nih.gov/books/NBK459157/",
      title: "Acute Coronary Syndrome",
      domain: "www.ncbi.nlm.nih.gov",
    }],
  };
  return normalizeVimeoTopicClassification({
    draft,
    proposal,
    request,
    evidence,
    model: "gpt-5.6",
    responseId: "resp_123",
    usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
    now: new Date("2026-07-25T10:05:00.000Z"),
  });
}

test("Vimeo discovery creates private drafts and preserves provider playback metadata", () => {
  const [row] = buildVimeoLibraryManifest([vimeoVideo()], {
    allowedSystems: ["Cardiovascular", "Renal"],
    catalogSourceId: "AYLA-VIMEO-SOURCE-usmle-step-1-9988",
    sourceFolder: { uri: "/me/projects/9988", name: "AylaMed lectures" },
  });
  assert.equal(row.ready, false);
  assert.equal(row.readyForClassification, true);
  assert.equal(row.approvalRequired, true);
  assert.equal(row.resource.examTrackId, "usmle_step_1");
  assert.equal(row.resource.system, "Cardiovascular");
  assert.equal(row.resource.topic, "Ischemic heart disease");
  assert.equal(row.resource.vimeoId, "123456");
  assert.equal(row.resource.vimeoPrivacyHash, "abc123");
  assert.equal(row.resource.sourceType, "vimeo_folder_library");
  assert.equal(row.resource.catalogSourceId, "AYLA-VIMEO-SOURCE-usmle-step-1-9988");
  assert.equal(row.resource.sourceData.folder_id, "9988");
  assert.equal(row.resource.sourceData.folder_name, "AylaMed lectures");
  assert.equal(row.resource.approved, false);
  assert.equal(row.resource.status, "draft_review");
  assert.deepEqual(row.resource.deliveryDestinations, []);
});

test("Vimeo metadata seeds preserve subsystem and subtopic without making the draft active", () => {
  const [row] = buildVimeoLibraryManifest([
    vimeoVideo({
      description: [
        "system: Cardiovascular",
        "subsystem: Ischemic heart disease",
        "topic: Acute coronary syndrome",
        "subtopic: Myocardial infarction",
        "playlist: Cardiology core",
      ].join("\n"),
    }),
  ], {
    examTrack: "usmle-step-1",
    allowedSystems: ["Cardiovascular", "Renal"],
  });
  assert.equal(row.resource.system, "Cardiovascular");
  assert.equal(row.resource.subsystem, "Ischemic heart disease");
  assert.equal(row.resource.topic, "Acute coronary syndrome");
  assert.equal(row.resource.subtopic, "Myocardial infarction");
  assert.equal(row.resource.approved, false);
  assert.deepEqual(row.resource.deliveryDestinations, []);
});

test("Vimeo discovery paginates through the selected folder with more than 400 lectures", async () => {
  const requestedPages = [];
  const requestedPaths = [];
  const apiClient = {
    async get(path, { params }) {
      requestedPaths.push(path);
      requestedPages.push(params.page);
      const start = (params.page - 1) * 100;
      return {
        data: {
          data: Array.from({ length: 100 }, (_, index) => ({
            uri: `/videos/${start + index + 1}`,
            name: `Medical topic ${start + index + 1}`,
          })),
          paging: { next: params.page < 5 ? `/me/projects/9988/videos?page=${params.page + 1}` : null },
        },
      };
    },
  };
  const videos = await fetchVimeoLibrary({
    folderId: "9988",
    token: "test-token",
    maximum: 450,
    apiClient,
  });
  assert.equal(videos.length, 450);
  assert.deepEqual(requestedPages, [1, 2, 3, 4, 5]);
  assert.deepEqual([...new Set(requestedPaths)], ["/me/projects/9988/videos"]);
  assert.equal(videos[449].uri, "/videos/450");
});

test("folder discovery and ongoing video sync have no fixed 400-lecture ceiling", async () => {
  const folderRequests = [];
  const apiClient = {
    async get(path, { params } = {}) {
      folderRequests.push({ path, page: params?.page || null });
      if (path === "/me/projects") {
        return {
          data: {
            data: [{ uri: "/users/7/projects/9988", name: "AylaMed lectures", metadata: { connections: { videos: { total: 525 } } } }],
            paging: { next: null },
          },
        };
      }
      if (path === "/me/projects/9988") {
        return { data: { uri: "/users/7/projects/9988", name: "AylaMed lectures" } };
      }
      const page = params.page;
      const count = page <= 5 ? 100 : 25;
      const start = (page - 1) * 100;
      return {
        data: {
          data: Array.from({ length: count }, (_, index) => ({
            uri: `/videos/${start + index + 1}`,
            name: `Medical topic ${start + index + 1}`,
          })),
          paging: { next: page < 6 ? `/me/projects/9988/videos?page=${page + 1}` : null },
        },
      };
    },
  };
  const folders = await fetchVimeoFolders({ apiClient });
  const folder = await fetchVimeoFolder({ folderId: folders[0].uri, apiClient });
  const videos = await fetchVimeoLibrary({ folderId: folder.id, apiClient });
  assert.equal(normalizeVimeoFolderId("https://vimeo.com/manage/folders/9988"), "9988");
  assert.equal(folders[0].video_count, 525);
  assert.equal(folder.id, "9988");
  assert.equal(videos.length, 525);
  assert.equal(folderRequests.filter((row) => row.path === "/me/projects/9988/videos").length, 6);
  assert.equal(folderRequests.some((row) => row.path === "/me/videos"), false);
});

test("a generic but named title stays private and classifiable instead of being guessed active", () => {
  const [row] = buildVimeoLibraryManifest([
    vimeoVideo({
      uri: "/videos/2",
      name: "Lecture 17",
      description: "",
      link: "https://vimeo.com/2",
      tags: [],
    }),
  ], {
    examTrack: "usmle-step-1",
    allowedSystems: ["Cardiovascular", "Renal"],
  });
  assert.equal(row.readyForClassification, true);
  assert.equal(row.resource.system, "");
  assert.equal(row.resource.approved, false);
  assert.deepEqual(row.resource.deliveryDestinations, []);
});

test("catalog upsert preserves unchanged work and requires reapproval after Vimeo metadata changes", () => {
  const [manifest] = buildVimeoLibraryManifest([vimeoVideo()], {
    allowedSystems: ["Cardiovascular"],
  });
  const created = upsertVimeoCatalogDraft(manifest, {}, {
    now: new Date("2026-07-25T10:00:00.000Z"),
  });
  assert.equal(created.created, true);
  assert.equal(created.draft.status, "pending_classification");
  assert.equal(created.draft.readyForClassification, true);
  assert.equal(created.draft.revision, 1);

  const approvedExisting = {
    ...created.draft,
    status: "approved",
    reviewStatus: "approved",
    classification: { medicalSystem: "Cardiovascular" },
  };
  const unchanged = upsertVimeoCatalogDraft(manifest, approvedExisting, {
    now: new Date("2026-07-25T10:01:00.000Z"),
  });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.draft.status, "approved");
  assert.deepEqual(unchanged.draft.classification, approvedExisting.classification);

  const [changedManifest] = buildVimeoLibraryManifest([
    vimeoVideo({ name: "Acute coronary syndrome — updated" }),
  ], { allowedSystems: ["Cardiovascular"] });
  const changed = upsertVimeoCatalogDraft(changedManifest, approvedExisting, {
    now: new Date("2026-07-25T10:02:00.000Z"),
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.draft.status, "needs_reapproval");
  assert.equal(changed.draft.reviewStatus, "needs_reapproval");
  assert.equal(changed.draft.previousApprovalPreserved, true);
  assert.equal(changed.draft.classification, null);
});

test("QBank candidate ranking favors the exact lecture heading", () => {
  const candidates = rankVimeoQbankTaxonomyCandidates({
    title: "Acute coronary syndrome",
    taxonomyRows: taxonomyRows(),
  });
  assert.equal(candidates[0].topicKey, "Acute coronary syndrome");
  assert.equal(candidates[0].systemKey, "Cardiovascular");
  assert.match(candidates[0].ref, /^QBANK-T\d{4}$/);
});

test("classification request requires web search and a strict review schema", () => {
  const request = buildVimeoTopicClassificationRequest(catalogDraft(), {
    examTrackLabel: "USMLE Step 1",
    allowedSystems: ["Cardiovascular", "Renal"],
    taxonomyRows: taxonomyRows(),
    taxonomyDefinition: {
      labels: {
        system: "Organ system or foundational domain",
        subsystem: "Subsystem or discipline",
        topic: "Topic",
        subtopic: "Learning objective",
      },
      blueprint_axes: ["organ_system", "physician_task_or_competency", "discipline"],
    },
    allowedDomains: ["ncbi.nlm.nih.gov", "usmle.org"],
  });
  assert.equal(request.toolChoice, "required");
  assert.deepEqual(request.include, ["web_search_call.action.sources"]);
  assert.equal(request.tools[0].type, "web_search");
  assert.deepEqual(request.tools[0].filters.allowed_domains, ["ncbi.nlm.nih.gov", "usmle.org"]);
  assert.equal(request.textFormat.type, "json_schema");
  assert.equal(request.textFormat.strict, true);
  assert.ok(request.textFormat.schema.required.includes("medical_subsystem"));
  assert.equal(request.taxonomyDefinition.labels.system, "Organ system or foundational domain");
  assert.match(request.systemPrompt, /Do not claim to inspect, watch, hear, or transcribe the video/);
  assert.match(request.systemPrompt, /untrusted metadata/);
  assert.match(request.systemPrompt, /owner is not a doctor/i);
  assert.match(request.systemPrompt, /compatibility names/i);
});

test("web-search evidence captures consulted sources and message citations", () => {
  const evidence = extractVimeoWebSearchEvidence([
    {
      type: "web_search_call",
      action: {
        queries: ["acute coronary syndrome"],
        sources: [{ url: "https://www.ncbi.nlm.nih.gov/books/NBK459157/", title: "ACS" }],
      },
    },
    {
      type: "message",
      content: [{
        type: "output_text",
        text: "{}",
        annotations: [{
          type: "url_citation",
          url: "https://medlineplus.gov/heartattack.html",
          title: "Heart attack",
        }],
      }],
    },
  ]);
  assert.equal(evidence.performed, true);
  assert.deepEqual(evidence.queries, ["acute coronary syndrome"]);
  assert.equal(evidence.sources.length, 2);
  assert.equal(evidence.sources[0].domain, "www.ncbi.nlm.nih.gov");
});

test("high-confidence researched classification is reviewable but never student-visible", () => {
  const classification = successfulClassification();
  assert.equal(classification.medicalSystem, "Cardiovascular");
  assert.equal(classification.medicalSubsystem, "Ischemic heart disease");
  assert.equal(classification.qbankTopic.topicKey, "Acute coronary syndrome");
  assert.equal(classification.qbankMatchKind, "exact_title");
  assert.equal(classification.webSearchPerformed, true);
  assert.equal(classification.evidenceSources.length, 1);
  assert.equal(classification.approvalReadiness, "ready_for_owner_approval");
  assert.equal(classification.requiresOwnerApproval, true);
  assert.equal(classification.studentVisible, false);
});

test("a QBank candidate from another system is never stored as a direct taxonomy link", () => {
  const draft = catalogDraft();
  const request = buildVimeoTopicClassificationRequest(draft, {
    allowedSystems: ["Cardiovascular", "Renal"],
    taxonomyRows: taxonomyRows(),
  });
  const classification = normalizeVimeoTopicClassification({
    draft,
    request,
    proposal: {
      interpreted_title: "Acute coronary syndrome",
      medical_system: "Renal",
      medical_subsystem: "Renal vascular disease",
      canonical_topic: "Acute coronary syndrome",
      subtopic: "",
      topic_aliases: [],
      qbank_topic_ref: request.candidates[0].ref,
      qbank_match_kind: "exact_title",
      plain_language_summary: "Conflicting hierarchy proposal.",
      classification_reason: "The proposed system does not match the approved candidate.",
      confidence_percent: 95,
      ambiguity_flags: [],
      alternative_mappings: [],
    },
    evidence: {
      performed: true,
      sources: [{ url: "https://www.ncbi.nlm.nih.gov/books/NBK459157/", title: "ACS" }],
    },
  });
  assert.equal(classification.qbankTopic, null);
  assert.equal(classification.qbankMatchKind, "no_match");
  assert.ok(classification.ambiguityFlags.includes("qbank_system_mismatch"));
  assert.equal(classification.approvalReadiness, "medical_review_recommended");
});

test("missing research evidence forces medical review and blocks approval", () => {
  const draft = catalogDraft();
  const request = buildVimeoTopicClassificationRequest(draft, {
    allowedSystems: ["Cardiovascular"],
    taxonomyRows: taxonomyRows(),
  });
  const classification = normalizeVimeoTopicClassification({
    draft,
    request,
    proposal: {
      medical_system: "Cardiovascular",
      canonical_topic: "Acute coronary syndrome",
      qbank_topic_ref: request.candidates[0].ref,
      qbank_match_kind: "exact_title",
      confidence_percent: 99,
    },
    evidence: { performed: false, sources: [] },
  });
  assert.equal(classification.approvalReadiness, "medical_review_recommended");
  assert.ok(classification.ambiguityFlags.includes("web_search_not_performed"));
  assert.throws(() => approveVimeoCatalogDraft({
    ...draft,
    classification,
  }, {
    expectedRevision: draft.revision,
  }), (error) => error.code === "VIMEO_WEB_CLASSIFICATION_REQUIRED");
});

test("generic headings and evidence outside the authoritative allowlist cannot become ready", () => {
  const [manifest] = buildVimeoLibraryManifest([
    vimeoVideo({ name: "Lecture 17", description: "" }),
  ], {
    examTrack: "usmle-step-1",
    allowedSystems: ["Cardiovascular"],
  });
  const draft = upsertVimeoCatalogDraft(manifest).draft;
  const request = buildVimeoTopicClassificationRequest(draft, {
    allowedSystems: ["Cardiovascular"],
    taxonomyRows: taxonomyRows(),
    allowedDomains: ["ncbi.nlm.nih.gov"],
  });
  const classification = normalizeVimeoTopicClassification({
    draft,
    request,
    proposal: {
      medical_system: "Cardiovascular",
      canonical_topic: "Cardiac electrophysiology",
      qbank_topic_ref: "",
      qbank_match_kind: "no_match",
      confidence_percent: 98,
    },
    evidence: {
      performed: true,
      sources: [{ url: "https://example.com/lecture-17", title: "Unapproved source" }],
    },
  });
  assert.equal(classification.approvalReadiness, "medical_review_recommended");
  assert.ok(classification.ambiguityFlags.includes("generic_title"));
  assert.ok(classification.ambiguityFlags.includes("no_authoritative_evidence"));
  assert.deepEqual(classification.evidenceSources, []);
});

test("approval is revision-checked and is the only step that enables student destinations", () => {
  const draft = catalogDraft();
  const classifiedDraft = {
    ...draft,
    status: "classified_pending_approval",
    classificationStatus: "completed",
    classification: successfulClassification(draft),
    revision: draft.revision + 1,
  };
  assert.throws(() => approveVimeoCatalogDraft(classifiedDraft, {
    expectedRevision: draft.revision,
  }), (error) => error.code === "STALE_VIMEO_MAPPING_REVIEW");

  const approved = approveVimeoCatalogDraft(classifiedDraft, {
    expectedRevision: classifiedDraft.revision,
    actor: { id: "admin-1", email: "owner@example.com" },
    now: new Date("2026-07-25T10:10:00.000Z"),
  });
  assert.equal(approved.draft.status, "approved");
  assert.equal(approved.resource.approved, true);
  assert.equal(approved.resource.status, "active");
  assert.equal(approved.resource.subsystem, "Ischemic heart disease");
  assert.deepEqual(approved.resource.hierarchyPath, [
    "Cardiovascular",
    "Ischemic heart disease",
    "Acute coronary syndrome",
    "Myocardial infarction",
  ]);
  assert.deepEqual(approved.resource.deliveryDestinations, ["aylamed_content_hub", "aylamed_roadmap"]);
  assert.equal(approved.resource.qbankLinkStatus, "approved_exact_or_synonym_link");
  assert.equal(approved.resource.adminApproval.reviewer.email, "owner@example.com");
});

test("approval cannot flatten a researched lecture by omitting its subsystem", () => {
  const draft = catalogDraft();
  const classification = {
    ...successfulClassification(draft),
    medicalSubsystem: "",
    qbankTopic: null,
  };
  assert.throws(() => approveVimeoCatalogDraft({
    ...draft,
    classification,
    revision: 2,
  }, {
    expectedRevision: 2,
  }), (error) => error.code === "VIMEO_MAPPING_INCOMPLETE");
});

test("a lecture missing from its managed folder cannot be newly approved or deleted implicitly", () => {
  const draft = catalogDraft();
  const missingDraft = {
    ...draft,
    folderMembershipStatus: "missing_from_folder",
    classification: successfulClassification(draft),
    revision: 2,
  };
  assert.throws(() => approveVimeoCatalogDraft(missingDraft, {
    expectedRevision: 2,
  }), (error) => error.code === "VIMEO_FOLDER_MEMBERSHIP_REQUIRED");
});

test("a broader QBank candidate can describe the topic but is not stored as a direct QBank link", () => {
  const draft = catalogDraft();
  const classification = successfulClassification(draft, {
    qbank_match_kind: "broader_topic",
    medical_subsystem: "Acute ischemic syndromes",
    canonical_topic: "ST-elevation myocardial infarction",
    subtopic: "Immediate reperfusion decisions",
  });
  const approved = approveVimeoCatalogDraft({
    ...draft,
    classification,
    revision: 2,
  }, {
    expectedRevision: 2,
  });
  assert.equal(approved.resource.qbankTaxonomy, null);
  assert.equal(approved.resource.qbankLinkStatus, "approved_related_topic_without_direct_qbank_link");
  assert.equal(approved.resource.subsystem, "Acute ischemic syndromes");
  assert.equal(approved.resource.topic, "ST-elevation myocardial infarction");
  assert.equal(approved.resource.subtopic, "Immediate reperfusion decisions");
});

test("catalog summary keeps approval readiness and web verification visible", () => {
  const draft = catalogDraft();
  const classification = successfulClassification(draft);
  const summary = vimeoCatalogSummary([
    { ...draft, status: "classified_pending_approval", classification },
    { ...draft, id: "draft-2", status: "approved", reviewStatus: "approved", classification },
    { ...draft, id: "draft-3", status: "rejected", reviewStatus: "rejected" },
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.webVerified, 2);
  assert.equal(summary.qbankLinked, 2);
  assert.equal(summary.readyForApproval, 1);
  assert.equal(summary.approved, 1);
  assert.equal(summary.hierarchyComplete, 2);
  assert.equal(summary.hierarchyIncomplete, 1);
  assert.equal(summary.approvedHierarchyComplete, 1);
  assert.equal(summary.bySubsystem["Cardiovascular → Ischemic heart disease"], 2);
});

test("server wiring is draft-first, background researched, and explicit-review only", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const AYLA_VIMEO_CATALOG_BUILD = VIMEO_LIBRARY_CATALOG_BUILD/);
  assert.match(server, /laneConcurrency: ngMultiQbankConfig\.lane_concurrency/);
  assert.match(server, /type: "ayla_vimeo_catalog_classification"/);
  assert.match(server, /priority: -20/);
  assert.match(server, /toolChoice: request\.toolChoice/);
  assert.match(server, /aylaV189ResourceType\(resource\.type\) === "vimeo_video" && aliasTopics\.includes\(topicKey\)/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/resources\/vimeo-catalog\/classification-jobs"/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/resources\/vimeo-catalog\/review"/);
  assert.match(server, /taxonomyDefinition: aylaContentHubTaxonomyDefinition\(draft\.examTrackId\)/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/resources\/vimeo-folders"/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/resources\/vimeo-catalog\/sources"/);
  assert.match(server, /ngStartAylaVimeoFolderSyncScheduler\(\)/);
  assert.match(server, /content_operations_have_priority/);
  assert.match(server, /folderMembershipStatus: "missing_from_folder"/);
  assert.match(server, /active_resources_created: 0/);
  assert.match(server, /Provide between 1 and 100 explicitly selected review items/);
  assert.match(server, /deliveryDestinations: \["aylamed_content_hub", "aylamed_roadmap"\]/);
  assert.match(server, /row\.classification\?\.medicalSubsystem/);
});
