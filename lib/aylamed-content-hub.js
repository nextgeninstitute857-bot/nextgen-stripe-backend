import { normalizeAylaRegistryExamTrack, normalizeAylaShellExamTrack } from "./aylamed-student-shell.js";

const BLOCKED_VIDEO_STATES = new Set(["archived", "deleted", "disabled", "quarantined", "rejected"]);
const VERIFIED_RIGHTS = new Set(["authorized", "admin_verified", "licensed", "owned", "approved_collection"]);
const TERMINAL_ASSIGNMENT_STATES = new Set(["cancelled", "canceled", "skipped", "superseded"]);
const CONTENT_HUB_TAXONOMY_DEFINITIONS = Object.freeze({
  usmle_step_1: Object.freeze({
    labels: Object.freeze({
      system: "Organ system or foundational domain",
      subsystem: "Subsystem or discipline",
      topic: "Topic",
      subtopic: "Learning objective",
    }),
    blueprint_axes: Object.freeze(["organ_system", "physician_task_or_competency", "discipline"]),
  }),
  usmle_step_2_ck: Object.freeze({
    labels: Object.freeze({
      system: "Clinical domain",
      subsystem: "System or discipline",
      topic: "Topic",
      subtopic: "Learning objective",
    }),
    blueprint_axes: Object.freeze(["organ_system", "physician_task", "discipline"]),
  }),
  usmle_step_3: Object.freeze({
    labels: Object.freeze({
      system: "Clinical domain",
      subsystem: "System or care setting",
      topic: "Topic",
      subtopic: "Clinical objective",
    }),
    blueprint_axes: Object.freeze(["organ_system", "physician_task", "care_setting"]),
  }),
  plab: Object.freeze({
    labels: Object.freeze({
      system: "Area of clinical practice",
      subsystem: "Presentation or condition",
      topic: "Topic",
      subtopic: "Capability or learning objective",
    }),
    blueprint_axes: Object.freeze(["professional_knowledge", "clinical_capability", "practical_skill"]),
  }),
  amc: Object.freeze({
    labels: Object.freeze({
      system: "Clinical field",
      subsystem: "Condition or discipline",
      topic: "Topic",
      subtopic: "Clinical task",
    }),
    blueprint_axes: Object.freeze(["clinical_field", "patient_group", "clinical_task"]),
  }),
  mccqe: Object.freeze({
    labels: Object.freeze({
      system: "Clinical area",
      subsystem: "Blueprint category",
      topic: "Objective",
      subtopic: "Learning point",
    }),
    blueprint_axes: Object.freeze(["dimension_of_care", "physician_activity", "canmeds_role"]),
  }),
  nclex: Object.freeze({
    labels: Object.freeze({
      system: "Client Need",
      subsystem: "Subcategory",
      topic: "Topic",
      subtopic: "Activity or concept",
    }),
    blueprint_axes: Object.freeze(["client_need", "integrated_process", "clinical_judgment"]),
  }),
});

function cleanString(value = "", max = 240) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanList(value) {
  const rows = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(rows.map((item) => cleanString(item, 180)).filter(Boolean))];
}

function cleanKey(value = "", fallback = "general") {
  return cleanString(value, 180).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

export function aylaContentHubTaxonomyDefinition(examTrack = "") {
  const examTrackId = normalizeAylaShellExamTrack(examTrack);
  const definition = CONTENT_HUB_TAXONOMY_DEFINITIONS[examTrackId] || {
    labels: {
      system: "Domain",
      subsystem: "Category",
      topic: "Topic",
      subtopic: "Learning objective",
    },
    blueprint_axes: [],
  };
  return {
    exam_track_id: examTrackId,
    primary_navigation: ["exam", "system", "subsystem", "topic", "subtopic"],
    labels: {
      exam: "Exam",
      ...definition.labels,
    },
    storage_fields: {
      domain: "system",
      category: "subsystem",
      topic: "topic",
      detail: "subtopic",
    },
    blueprint_axes: [...definition.blueprint_axes],
    model: "primary_tree_with_blueprint_axes",
  };
}

function numberBetween(value, minimum, maximum, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function values(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.values(input);
  return [];
}

function timestamp(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function vimeoIdentity(input = {}) {
  const directId = cleanString(
    input.providerId || input.provider_id || input.vimeoId || input.vimeo_id,
    40,
  );
  const privacyHash = cleanString(
    input.vimeoPrivacyHash || input.vimeo_privacy_hash || input.privacyHash || input.privacy_hash,
    120,
  ).replace(/[^a-z0-9_-]/gi, "");
  if (/^\d+$/.test(directId)) return { id: directId, privacyHash };

  const candidates = [
    input.vimeoEmbedUrl,
    input.vimeo_embed_url,
    input.embedUrl,
    input.embed_url,
    input.vimeoUrl,
    input.vimeo_url,
    input.videoUrl,
    input.video_url,
  ];
  for (const candidate of candidates) {
    const raw = cleanString(candidate, 1000);
    if (!raw) continue;
    let match = null;
    let queryHash = "";
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      if (!["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) continue;
      match = parsed.pathname.match(/^\/(?:video\/)?(\d+)(?:\/([a-z0-9_-]+))?\/?$/i);
      queryHash = cleanString(parsed.searchParams.get("h"), 120).replace(/[^a-z0-9_-]/gi, "");
    } catch {
      match = raw.match(/^(?:(?:https?:\/\/)?(?:www\.|player\.)?vimeo\.com\/)(?:video\/)?(\d+)(?:\/([a-z0-9_-]+))?\/?(?:\?h=([a-z0-9_-]+))?$/i);
      queryHash = match?.[3] || "";
    }
    if (!match) continue;
    return { id: match[1], privacyHash: privacyHash || queryHash || match[2] || "" };
  }
  return null;
}

export function aylaContentHubEmbedUrl(input = {}) {
  const identity = vimeoIdentity(input);
  if (!identity) return null;
  return `https://player.vimeo.com/video/${identity.id}${identity.privacyHash ? `?h=${encodeURIComponent(identity.privacyHash)}` : ""}`;
}

function contentHubResourceId(input = {}, sourceType = "legacy") {
  const explicit = cleanString(input.resourceId || input.resource_id, 180);
  if (explicit) return explicit;
  const id = cleanString(input.id || input.video_asset_id, 180);
  if (!id) return null;
  return sourceType === "registry" && !id.startsWith("registry-video:") ? `registry-video:${id}` : id;
}

function inferredTitle(input = {}) {
  const explicit = cleanString(input.title || input.video_title, 240);
  if (explicit) return explicit;
  const original = cleanString(input.originalName || input.original_name, 240).replace(/\.[a-z0-9]{2,6}$/i, "");
  return original.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim() || "Video lesson";
}

function sourceLabel(input = {}, sourceType = "legacy") {
  const direct = cleanString(input.sourceLabel || input.source_label, 160);
  if (direct) return direct;
  const visible = input.sourceLabelVisible === true || input.source_label_visible === true;
  if (sourceType === "legacy" && visible) return cleanString(input.provider, 160) || null;
  return null;
}

export function normalizeAylaContentHubVideo(input = {}, { examTrack = null } = {}) {
  const rawSourceType = cleanString(input.sourceType || input.source_type, 80).toLowerCase().replace(/[\s-]+/g, "_");
  const sourceType = rawSourceType || "legacy";
  const resourceId = contentHubResourceId(input, sourceType);
  const examTrackId = normalizeAylaShellExamTrack(
    input.examTrackId || input.exam_track_id || input.examTrack || input.exam_track || input.exam,
  );
  const requestedExamTrackId = examTrack ? normalizeAylaShellExamTrack(examTrack) : null;
  const status = cleanString(input.status || "active", 40).toLowerCase();
  const authorizationStatus = cleanString(
    input.authorizationStatus || input.authorization_status || (sourceType === "registry" ? "approved_collection" : ""),
    80,
  ).toLowerCase();
  const embedUrl = aylaContentHubEmbedUrl(input);
  if (!resourceId || !examTrackId || (requestedExamTrackId && requestedExamTrackId !== examTrackId)) return null;
  if (input.approved === false || BLOCKED_VIDEO_STATES.has(status) || !VERIFIED_RIGHTS.has(authorizationStatus) || !embedUrl) return null;

  const identity = vimeoIdentity(input);
  const system = cleanString(input.system || input.systemKey || input.system_key || "General", 120) || "General";
  const topic = cleanString(input.topic || input.topicKey || input.topic_key || inferredTitle(input), 180);
  const qbankTaxonomy = input.qbankTaxonomy || input.qbank_taxonomy || {};
  const subsystem = cleanString(
    input.subsystem
      || input.subsystemKey
      || input.subsystem_key
      || qbankTaxonomy.subsystemKey
      || qbankTaxonomy.subsystem_key,
    180,
  );
  const topicAliases = cleanList([
    ...cleanList(input.topicAliases || input.topic_aliases),
    qbankTaxonomy.topicKey || qbankTaxonomy.topic_key,
    qbankTaxonomy.subtopicKey || qbankTaxonomy.subtopic_key,
  ]);
  const explicitPlaylistKey = cleanString(input.playlistKey || input.playlist_key, 180);
  const playlistKey = cleanKey(explicitPlaylistKey || system);
  const durationSeconds = Math.round(numberBetween(
    input.durationSeconds || input.duration_seconds || input.source_data?.duration_seconds,
    0,
    24 * 60 * 60,
    0,
  ));
  const startSeconds = Math.round(numberBetween(input.videoStartSeconds || input.video_start_seconds, 0, 24 * 60 * 60, 0));
  const requestedEnd = Math.round(numberBetween(input.videoEndSeconds || input.video_end_seconds, 0, 24 * 60 * 60, 0));
  const endSeconds = requestedEnd > startSeconds ? requestedEnd : 0;
  const estimatedMinutes = Math.max(1, Math.min(240, Math.round(numberBetween(
    input.estimatedMinutes || input.estimated_minutes,
    1,
    240,
    durationSeconds ? Math.ceil(durationSeconds / 60) : 20,
  ))));
  const deliveryDestinations = cleanList(input.deliveryDestinations || input.delivery_destinations || input.destinations)
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));

  return {
    id: resourceId,
    aliasResourceIds: [...new Set([resourceId, ...cleanList(input.aliasResourceIds || input.alias_resource_ids)])],
    providerKey: identity?.id || embedUrl,
    sourceType,
    type: "vimeo_video",
    examTrackId,
    examTrack: normalizeAylaRegistryExamTrack(examTrackId),
    title: inferredTitle(input),
    description: cleanString(input.description || input.summary, 1000),
    system,
    subsystem,
    topic,
    topicAliases,
    subtopic: cleanString(
      input.subtopic
        || input.subtopicKey
        || input.subtopic_key
        || qbankTaxonomy.subtopicKey
        || qbankTaxonomy.subtopic_key,
      180,
    ),
    playlistKey,
    playlistTitle: cleanString(input.playlistTitle || input.playlist_title, 180) || system,
    vimeoEmbedUrl: embedUrl,
    videoStartSeconds: startSeconds,
    videoEndSeconds: endSeconds,
    durationSeconds,
    estimatedMinutes,
    sourceLabel: sourceLabel(input, sourceType),
    authorizationStatus,
    verificationStatus: cleanString(input.verificationStatus || input.verification_status || (sourceType === "registry" ? "approved_content_registry" : "verified"), 100),
    mappingStatus: cleanString(input.mappingStatus || input.mapping_status || (sourceType === "registry" ? "approved_registry_taxonomy" : ""), 100),
    deliveryDestinations,
    collectionId: cleanString(input.collectionId || input.collection_id, 180) || null,
    priority: cleanString(input.priority || "High", 40),
    relevance: numberBetween(input.relevance || input.roadmap_priority, -1000, 1000, sourceType === "registry" ? 30 : 0),
    createdAt: input.createdAt || input.created_at || null,
    updatedAt: input.updatedAt || input.updated_at || null,
  };
}

export function normalizeAylaContentHubVideos(videos = [], { examTrack = null } = {}) {
  const byProvider = new Map();
  for (const input of values(videos)) {
    const video = normalizeAylaContentHubVideo(input, { examTrack });
    if (!video) continue;
    const existing = byProvider.get(video.providerKey);
    if (!existing) {
      byProvider.set(video.providerKey, video);
      continue;
    }
    const preferred = existing.sourceType === "registry" || video.sourceType !== "registry" ? existing : video;
    const secondary = preferred === existing ? video : existing;
    byProvider.set(video.providerKey, {
      ...secondary,
      ...preferred,
      aliasResourceIds: [...new Set([...existing.aliasResourceIds, ...video.aliasResourceIds])],
      topicAliases: [...new Set([...existing.topicAliases, ...video.topicAliases])],
      deliveryDestinations: [...new Set([...existing.deliveryDestinations, ...video.deliveryDestinations])],
      subsystem: preferred.subsystem || secondary.subsystem || "",
      subtopic: preferred.subtopic || secondary.subtopic || "",
      sourceLabel: preferred.sourceLabel || secondary.sourceLabel || null,
      relevance: Math.max(existing.relevance, video.relevance),
    });
  }
  return [...byProvider.values()].sort((left, right) =>
    String(left.system).localeCompare(String(right.system))
      || String(left.subsystem).localeCompare(String(right.subsystem))
      || String(left.topic).localeCompare(String(right.topic))
      || String(left.title).localeCompare(String(right.title))
      || String(left.id).localeCompare(String(right.id)));
}

export function aylaContentHubVideoMatchesId(video = {}, resourceId = "") {
  const wanted = cleanString(resourceId, 180);
  return Boolean(wanted && [video.id, ...cleanList(video.aliasResourceIds)].some((id) => String(id) === wanted));
}

function progressMatchesVideo(progress = {}, video = {}) {
  return aylaContentHubVideoMatchesId(video, progress.resourceId || progress.resource_id);
}

function assignmentMatchesVideo(assignment = {}, video = {}) {
  if (TERMINAL_ASSIGNMENT_STATES.has(cleanString(assignment.status, 40).toLowerCase())) return false;
  const ids = [
    ...cleanList(assignment.resourceIds || assignment.resource_ids),
    ...values(assignment.items).map((item) => item?.resourceId || item?.resource_id).filter(Boolean),
  ];
  return ids.some((id) => aylaContentHubVideoMatchesId(video, id));
}

function latestVideoProgress(progressRows = [], video = {}) {
  return values(progressRows)
    .filter((row) => progressMatchesVideo(row, video))
    .sort((left, right) => timestamp(right.updatedAt || right.updated_at) - timestamp(left.updatedAt || left.updated_at))[0] || null;
}

function videoAssignment(assignments = [], video = {}) {
  return values(assignments)
    .filter((row) => assignmentMatchesVideo(row, video))
    .sort((left, right) => timestamp(right.updatedAt || right.updated_at || right.createdAt || right.created_at) - timestamp(left.updatedAt || left.updated_at || left.createdAt || left.created_at))[0] || null;
}

export function aylaContentHubAssignmentProgress(assignment = {}, progressRows = []) {
  const resourceIds = [...new Set([
    ...cleanList(assignment.resourceIds || assignment.resource_ids),
    ...values(assignment.items).map((item) => cleanString(item?.resourceId || item?.resource_id, 180)).filter(Boolean),
  ])];
  const assignmentId = cleanString(assignment.id, 180);
  const rows = values(progressRows).filter((row) => {
    const rowAssignmentId = cleanString(row.assignmentId || row.assignment_id, 180);
    return !rowAssignmentId || !assignmentId || rowAssignmentId === assignmentId;
  });
  const resourceProgress = resourceIds.map((resourceId) => {
    const watchedPercent = rows.filter((row) => [
      cleanString(row.resourceId || row.resource_id, 180),
      ...cleanList(row.aliasResourceIds || row.alias_resource_ids),
    ].includes(resourceId)).reduce((best, row) => Math.max(
      best,
      numberBetween(row.watchedPercent ?? row.watched_percent, 0, 100, 0),
    ), 0);
    return { resource_id: resourceId, watched_percent: watchedPercent, completed: watchedPercent >= 90 };
  });
  const watchedPercent = resourceProgress.length
    ? Math.round(resourceProgress.reduce((sum, row) => sum + row.watched_percent, 0) / resourceProgress.length)
    : 0;
  return {
    resource_count: resourceProgress.length,
    watched_percent: watchedPercent,
    completed: resourceProgress.length > 0 && resourceProgress.every((row) => row.completed),
    resources: resourceProgress,
  };
}

export function sanitizeAylaContentHubVideo(video = {}, { progress = null, assignment = null } = {}) {
  return {
    id: video.id,
    title: video.title,
    description: video.description || "",
    exam_track_id: video.examTrackId,
    exam_track: video.examTrack,
    system: video.system,
    subsystem: video.subsystem || "",
    topic: video.topic,
    subtopic: video.subtopic || "",
    hierarchy_path: [video.system, video.subsystem, video.topic, video.subtopic].filter(Boolean),
    playlist_key: video.playlistKey,
    playlist_title: video.playlistTitle,
    embed_url: video.vimeoEmbedUrl,
    start_seconds: video.videoStartSeconds || 0,
    end_seconds: video.videoEndSeconds || 0,
    duration_seconds: video.durationSeconds || 0,
    estimated_minutes: video.estimatedMinutes,
    source_label: video.sourceLabel || null,
    source_type: video.sourceType,
    progress: progress ? {
      watched_percent: numberBetween(progress.watchedPercent ?? progress.watched_percent, 0, 100, 0),
      last_position_seconds: numberBetween(progress.lastPositionSeconds ?? progress.last_position_seconds, 0, 24 * 60 * 60, 0),
      completed: progress.completed === true || Number((progress.watchedPercent ?? progress.watched_percent) || 0) >= 90,
      updated_at: progress.updatedAt || progress.updated_at || null,
    } : { watched_percent: 0, last_position_seconds: 0, completed: false, updated_at: null },
    roadmap_assignment: assignment ? {
      id: assignment.id,
      date: assignment.scheduledDate || assignment.scheduled_date || null,
      status: assignment.status || "pending",
      title: assignment.title || null,
    } : null,
  };
}

function buildAylaContentHubHierarchy(videos = []) {
  const systems = new Map();
  for (const video of videos) {
    const systemTitle = cleanString(video.system, 180) || "Unclassified";
    const subsystemTitle = cleanString(video.subsystem, 180) || "Unclassified";
    const topicTitle = cleanString(video.topic, 240) || cleanString(video.title, 240) || "Unclassified";
    const subtopicTitle = cleanString(video.subtopic, 240);
    const systemKey = cleanKey(systemTitle, "unclassified");
    const subsystemKey = cleanKey(subsystemTitle, "unclassified");
    const topicKey = cleanKey(topicTitle, "unclassified");

    const system = systems.get(systemKey) || {
      key: systemKey,
      title: systemTitle,
      level: "system",
      video_count: 0,
      subsystems: new Map(),
    };
    const subsystem = system.subsystems.get(subsystemKey) || {
      key: subsystemKey,
      title: subsystemTitle,
      level: "subsystem",
      video_count: 0,
      topics: new Map(),
    };
    const topic = subsystem.topics.get(topicKey) || {
      key: topicKey,
      title: topicTitle,
      level: "topic",
      video_count: 0,
      subtopics: new Map(),
    };

    system.video_count += 1;
    subsystem.video_count += 1;
    topic.video_count += 1;
    if (subtopicTitle) {
      const subtopicKey = cleanKey(subtopicTitle, "unclassified");
      const subtopic = topic.subtopics.get(subtopicKey) || {
        key: subtopicKey,
        title: subtopicTitle,
        level: "subtopic",
        video_count: 0,
      };
      subtopic.video_count += 1;
      topic.subtopics.set(subtopicKey, subtopic);
    }
    subsystem.topics.set(topicKey, topic);
    system.subsystems.set(subsystemKey, subsystem);
    systems.set(systemKey, system);
  }

  return [...systems.values()]
    .sort((left, right) => left.title.localeCompare(right.title))
    .map((system) => ({
      key: system.key,
      title: system.title,
      level: system.level,
      video_count: system.video_count,
      subsystems: [...system.subsystems.values()]
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((subsystem) => ({
          key: subsystem.key,
          title: subsystem.title,
          level: subsystem.level,
          video_count: subsystem.video_count,
          topics: [...subsystem.topics.values()]
            .sort((left, right) => left.title.localeCompare(right.title))
            .map((topic) => ({
              key: topic.key,
              title: topic.title,
              level: topic.level,
              video_count: topic.video_count,
              subtopics: [...topic.subtopics.values()]
                .sort((left, right) => left.title.localeCompare(right.title)),
            })),
        })),
    }));
}

export function buildAylaContentHubCatalog({
  videos = [],
  examTrack,
  progressRows = [],
  assignments = [],
  filters = {},
  limit = 200,
  offset = 0,
} = {}) {
  const normalized = normalizeAylaContentHubVideos(videos, { examTrack });
  const assigned = (video) => videoAssignment(assignments, video);
  const available = normalized.filter((video) =>
    video.sourceType !== "registry"
      || video.deliveryDestinations.includes("aylamed_content_hub")
      || Boolean(assigned(video)));
  const system = cleanKey(filters.system || filters.system_key, "");
  const subsystem = cleanKey(filters.subsystem || filters.subsystem_key, "");
  const topic = cleanKey(filters.topic || filters.topic_key, "");
  const subtopic = cleanKey(filters.subtopic || filters.subtopic_key, "");
  const playlist = cleanKey(filters.playlist || filters.playlist_key, "");
  const search = cleanString(filters.search || filters.q, 180).toLowerCase();
  const filtered = available.filter((video) => {
    if (system && cleanKey(video.system, "") !== system) return false;
    if (subsystem && cleanKey(video.subsystem, "") !== subsystem) return false;
    if (topic && ![video.topic, ...video.topicAliases].some((value) => cleanKey(value, "") === topic)) return false;
    if (subtopic && ![video.subtopic, ...video.topicAliases].some((value) => cleanKey(value, "") === subtopic)) return false;
    if (playlist && cleanKey(video.playlistKey, "") !== playlist) return false;
    if (search && !`${video.title} ${video.description} ${video.system} ${video.subsystem} ${video.topic} ${video.subtopic} ${video.topicAliases.join(" ")}`.toLowerCase().includes(search)) return false;
    return true;
  });
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 200)));
  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  const serialized = page.map((video) => sanitizeAylaContentHubVideo(video, {
    progress: latestVideoProgress(progressRows, video),
    assignment: assigned(video),
  }));
  const playlists = new Map();
  for (const video of serialized) {
    const row = playlists.get(video.playlist_key) || {
      key: video.playlist_key,
      title: video.playlist_title,
      system: video.system,
      subsystems: new Set(),
      topics: new Set(),
      videos: [],
    };
    if (video.subsystem) row.subsystems.add(video.subsystem);
    if (video.topic) row.topics.add(video.topic);
    row.videos.push(video);
    playlists.set(video.playlist_key, row);
  }
  const facets = {
    systems: [...new Set(available.map((video) => video.system).filter(Boolean))].sort(),
    subsystems: [...new Set(available.map((video) => video.subsystem).filter(Boolean))].sort(),
    topics: [...new Set(available.map((video) => video.topic).filter(Boolean))].sort(),
    subtopics: [...new Set(available.map((video) => video.subtopic).filter(Boolean))].sort(),
    playlists: [...new Set(available.map((video) => video.playlistKey).filter(Boolean))].sort(),
  };
  return {
    exam_track_id: normalizeAylaShellExamTrack(examTrack),
    exam_track: normalizeAylaRegistryExamTrack(examTrack),
    taxonomy: aylaContentHubTaxonomyDefinition(examTrack),
    total: filtered.length,
    limit: safeLimit,
    offset: safeOffset,
    has_more: safeOffset + serialized.length < filtered.length,
    filters: {
      system: system || null,
      subsystem: subsystem || null,
      topic: topic || null,
      subtopic: subtopic || null,
      playlist: playlist || null,
      search: search || null,
    },
    facets,
    hierarchy: buildAylaContentHubHierarchy(filtered),
    continue_watching: serialized.filter((video) => video.progress.watched_percent > 0 && !video.progress.completed),
    playlists: [...playlists.values()].map((row) => ({
      ...row,
      subsystems: [...row.subsystems].sort(),
      topics: [...row.topics].sort(),
      video_count: row.videos.length,
    })),
    videos: serialized,
  };
}

export function selectAylaRoadmapVideo({
  videos = [],
  examTrack,
  focusSystem = "",
  focusSubsystem = "",
  focusTopic = "",
  progressRows = [],
  reservedResourceIds = [],
  preferredResourceIds = [],
} = {}) {
  const reserved = new Set(cleanList(reservedResourceIds));
  const preferred = new Map(cleanList(preferredResourceIds).map((id, index) => [id, index]));
  const systemKey = cleanKey(focusSystem, "");
  const subsystemKey = cleanKey(focusSubsystem, "");
  const topicKey = cleanKey(focusTopic, "");
  const candidates = normalizeAylaContentHubVideos(videos, { examTrack })
    .filter((video) => video.deliveryDestinations.length === 0 || video.deliveryDestinations.includes("aylamed_roadmap"))
    .filter((video) => !video.aliasResourceIds.some((id) => reserved.has(id)))
    .map((video) => {
      const progress = latestVideoProgress(progressRows, video);
      const completed = progress?.completed === true || Number((progress?.watchedPercent ?? progress?.watched_percent) || 0) >= 90;
      const systemMatch = Boolean(systemKey && cleanKey(video.system, "") === systemKey);
      const subsystemMatch = Boolean(subsystemKey && cleanKey(video.subsystem, "") === subsystemKey);
      const topicMatch = Boolean(topicKey && [video.topic, video.subtopic, ...video.topicAliases]
        .some((value) => cleanKey(value, "") === topicKey));
      const preferenceIndex = video.aliasResourceIds.map((id) => preferred.get(id)).find((index) => index !== undefined);
      const resume = !completed && Number((progress?.watchedPercent ?? progress?.watched_percent) || 0) > 0;
      const score = (topicMatch ? 500 : subsystemMatch ? 350 : systemMatch ? 250 : systemKey || subsystemKey ? -1000 : 0)
        + (resume ? 120 : 0)
        + (preferenceIndex !== undefined ? Math.max(1, 100 - preferenceIndex) : 0)
        + numberBetween(video.relevance, -100, 100, 0);
      return { video, progress, completed, systemMatch, subsystemMatch, topicMatch, resume, score };
    })
    .filter((row) => !row.completed
      && (!systemKey || row.systemMatch)
      && (!subsystemKey || row.subsystemMatch))
    .sort((left, right) => right.score - left.score || String(left.video.id).localeCompare(String(right.video.id)));
  const selected = candidates[0] || null;
  if (!selected) return { video: null, match_level: "none", resumed: false, reason: "no_verified_video_for_focus" };
  return {
    video: selected.video,
    match_level: selected.topicMatch
      ? "exact_topic"
      : selected.subsystemMatch
        ? "subsystem"
        : selected.systemMatch
          ? "system"
          : "general",
    resumed: selected.resume,
    reason: selected.resume ? "resume_verified_video" : "best_verified_focus_match",
  };
}

export function mergeAylaContentHubProgress(existing = {}, incoming = {}, now = new Date()) {
  const updatedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const watchedPercent = Math.max(
    numberBetween(existing.watchedPercent ?? existing.watched_percent, 0, 100, 0),
    numberBetween(incoming.watchedPercent ?? incoming.watched_percent, 0, 100, 0),
  );
  const lastPositionSeconds = Math.max(
    numberBetween(existing.lastPositionSeconds ?? existing.last_position_seconds, 0, 24 * 60 * 60, 0),
    numberBetween(incoming.lastPositionSeconds ?? incoming.last_position_seconds, 0, 24 * 60 * 60, 0),
  );
  const completed = existing.completed === true || watchedPercent >= 90;
  return {
    ...existing,
    ...incoming,
    watchedPercent,
    lastPositionSeconds,
    completed,
    startedAt: existing.startedAt || existing.started_at || incoming.startedAt || incoming.started_at || updatedAt,
    completedAt: completed ? existing.completedAt || existing.completed_at || incoming.completedAt || incoming.completed_at || updatedAt : null,
    updatedAt,
  };
}

export function mergeAylaContentHubProgressCollection(latest = {}, incoming = {}) {
  const combined = new Map();
  for (const row of [...values(latest), ...values(incoming)]) {
    if (!row?.id && !(row?.studentId || row?.student_id) && !(row?.resourceId || row?.resource_id)) continue;
    const key = `${row.studentId || row.student_id || ""}|${row.resourceId || row.resource_id || row.id || ""}`;
    const existing = combined.get(key);
    if (!existing) {
      combined.set(key, { ...row });
      continue;
    }
    const newer = timestamp(row.updatedAt || row.updated_at) >= timestamp(existing.updatedAt || existing.updated_at) ? row : existing;
    const older = newer === row ? existing : row;
    combined.set(key, mergeAylaContentHubProgress(older, newer, newer.updatedAt || newer.updated_at || new Date()));
  }
  return Object.fromEntries([...combined.values()].map((row) => [String(row.id || `${row.studentId || row.student_id}:${row.resourceId || row.resource_id}`), row]));
}
