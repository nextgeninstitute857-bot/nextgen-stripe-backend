const DESTINATIONS = Object.freeze({
  content_hub: "contentHubEnabled",
  roadmap: "roadmapEnabled",
});

const SCOPE_PRIORITY = Object.freeze({
  type: 1,
  folder: 2,
  video: 3,
});

function clean(value, maximum = 240) {
  return String(value ?? "").trim().slice(0, maximum);
}

function cleanKey(value, fallback = "") {
  const normalized = clean(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function cleanBoolean(value, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  if (value === true || value === false) return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return nullable ? null : true;
}

function cleanList(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .flatMap((item) => typeof item === "string" ? item.split(/[\n,]+/) : [item])
    .map((item) => clean(item))
    .filter(Boolean))];
}

export function normalizeAylaVimeoDeliveryControl(input = {}, existing = {}) {
  const scope = cleanKey(input.scope ?? existing.scope);
  if (!Object.hasOwn(SCOPE_PRIORITY, scope)) {
    const error = new Error("scope must be type, folder, or video");
    error.statusCode = 400;
    throw error;
  }

  const examTrackId = cleanKey(
    input.examTrackId
      ?? input.exam_track_id
      ?? input.examTrack
      ?? input.exam_track
      ?? existing.examTrackId
      ?? "*",
    "*",
  );
  const target = clean(
    input.target
      ?? input.targetId
      ?? input.target_id
      ?? input.videoId
      ?? input.video_id
      ?? input.folderId
      ?? input.folder_id
      ?? input.catalogSourceId
      ?? input.catalog_source_id
      ?? existing.target,
  );
  const videoType = cleanKey(input.videoType ?? input.video_type ?? existing.videoType ?? "vimeo_lecture", "vimeo_lecture");
  if (scope !== "type" && !target) {
    const error = new Error(`${scope}_id is required`);
    error.statusCode = 400;
    throw error;
  }

  const id = scope === "type"
    ? `AYLA-VIMEO-DELIVERY-type-${examTrackId}-${videoType}`
    : `AYLA-VIMEO-DELIVERY-${scope}-${examTrackId}-${cleanKey(target)}`;
  return {
    ...existing,
    id,
    type: "vimeo_delivery_control",
    scope,
    target: scope === "type" ? videoType : target,
    videoType,
    examTrackId,
    contentHubEnabled: cleanBoolean(
      input.contentHubEnabled ?? input.content_hub_enabled ?? existing.contentHubEnabled,
    ),
    roadmapEnabled: cleanBoolean(
      input.roadmapEnabled ?? input.roadmap_enabled ?? existing.roadmapEnabled,
    ),
  };
}

export function aylaVimeoDeliveryIdentity(resource = {}) {
  const sourceData = resource.sourceData || resource.source_data || {};
  const vimeoId = clean(
    resource.vimeoId
      || resource.vimeo_id
      || sourceData.vimeo_id
      || String(resource.vimeoUri || sourceData.vimeo_uri || "").match(/\/videos\/(\d+)/)?.[1]
      || "",
  );
  const folderId = clean(
    resource.folderId
      || resource.folder_id
      || sourceData.folder_id
      || String(resource.sourceNamespace || resource.source_namespace || "").match(/^vimeo_folder:(.+)$/)?.[1]
      || "",
  );
  const catalogSourceId = clean(
    resource.catalogSourceId
      || resource.catalog_source_id
      || sourceData.catalog_source_id
      || "",
  );
  const resourceIds = cleanList([
    resource.id,
    resource.resourceId,
    resource.resource_id,
    resource.providerKey,
    resource.provider_key,
    vimeoId,
    ...(resource.aliasResourceIds || resource.alias_resource_ids || []),
  ]);
  return {
    examTrackId: cleanKey(
      resource.examTrackId
        || resource.exam_track_id
        || resource.examTrack
        || resource.exam_track
        || resource.exam
        || "",
    ),
    videoType: cleanKey(resource.videoType || resource.video_type || "vimeo_lecture", "vimeo_lecture"),
    vimeoId,
    folderId,
    catalogSourceId,
    resourceIds,
  };
}

function controlMatches(control, identity) {
  if (control.examTrackId && control.examTrackId !== "*" && control.examTrackId !== identity.examTrackId) return false;
  if (control.scope === "type") return control.videoType === identity.videoType;
  if (control.scope === "folder") {
    return [identity.folderId, identity.catalogSourceId, `vimeo_folder:${identity.folderId}`]
      .filter(Boolean)
      .includes(control.target);
  }
  if (control.scope === "video") return identity.resourceIds.includes(control.target);
  return false;
}

function matchingControls(resource, controls) {
  const identity = aylaVimeoDeliveryIdentity(resource);
  return (Array.isArray(controls) ? controls : Object.values(controls || {}))
    .map((row) => {
      try {
        return normalizeAylaVimeoDeliveryControl(row, row);
      } catch {
        return null;
      }
    })
    .filter((row) => row && controlMatches(row, identity))
    .sort((left, right) =>
      SCOPE_PRIORITY[right.scope] - SCOPE_PRIORITY[left.scope]
      || Number(right.examTrackId !== "*") - Number(left.examTrackId !== "*")
      || String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function resolveAylaVimeoDelivery(resource = {}, controls = []) {
  const matches = matchingControls(resource, controls);
  const resolution = {};
  for (const [destination, field] of Object.entries(DESTINATIONS)) {
    const selected = matches.find((control) => control[field] !== null);
    resolution[destination] = selected ? selected[field] === true : true;
    resolution[`${destination}_source`] = selected
      ? { control_id: selected.id, scope: selected.scope, target: selected.target }
      : { control_id: null, scope: "default", target: null };
  }
  return {
    content_hub_enabled: resolution.content_hub,
    roadmap_enabled: resolution.roadmap,
    content_hub_source: resolution.content_hub_source,
    roadmap_source: resolution.roadmap_source,
    mode: !resolution.content_hub && resolution.roadmap
      ? "hidden_from_content_hub"
      : !resolution.content_hub && !resolution.roadmap
        ? "disabled_everywhere"
        : resolution.content_hub && !resolution.roadmap
          ? "content_hub_only"
          : "active",
  };
}

export function aylaVimeoAllowedFor(resource = {}, controls = [], destination = "content_hub") {
  const key = cleanKey(destination);
  const resolved = resolveAylaVimeoDelivery(resource, controls);
  if (key === "roadmap" || key === "aylamed_roadmap") return resolved.roadmap_enabled;
  if (key === "notes" || key === "history") return true;
  return resolved.content_hub_enabled;
}

export function summarizeAylaVimeoDeliveryControls(controls = []) {
  const rows = (Array.isArray(controls) ? controls : Object.values(controls || {}))
    .map((row) => {
      try {
        return normalizeAylaVimeoDeliveryControl(row, row);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    total: rows.length,
    by_scope: rows.reduce((counts, row) => ({
      ...counts,
      [row.scope]: Number(counts[row.scope] || 0) + 1,
    }), {}),
    content_hub_off: rows.filter((row) => row.contentHubEnabled === false).length,
    roadmap_off: rows.filter((row) => row.roadmapEnabled === false).length,
  };
}

function collectionValues(db, key) {
  const collection = db?.[key] || {};
  return Array.isArray(collection) ? collection : Object.values(collection);
}

function deleteCollectionRows(db, key, predicate) {
  const collection = db?.[key] || {};
  if (Array.isArray(collection)) {
    const kept = collection.filter((row) => !predicate(row));
    const deleted = collection.length - kept.length;
    db[key] = kept;
    return deleted;
  }
  let deleted = 0;
  for (const [id, row] of Object.entries(collection)) {
    if (!predicate(row)) continue;
    delete collection[id];
    deleted += 1;
  }
  return deleted;
}

function exactReference(value, aliases) {
  return Boolean(clean(value) && aliases.has(clean(value)));
}

function blockReferencesVideo(block = {}, aliases) {
  const source = block.source || {};
  return [
    block.resourceId,
    block.resource_id,
    block.providerVideoId,
    block.provider_video_id,
    source.resourceId,
    source.resource_id,
    source.providerVideoId,
    source.provider_video_id,
    source.vimeoId,
    source.vimeo_id,
  ].some((value) => exactReference(value, aliases));
}

function matchingVimeoRows(db, target) {
  const wanted = clean(target);
  const resources = collectionValues(db, "aylaResources").filter((row) => {
    const identity = aylaVimeoDeliveryIdentity(row);
    return identity.vimeoId === wanted || identity.resourceIds.includes(wanted);
  });
  const drafts = collectionValues(db, "aylaVimeoCatalogDrafts").filter((row) => {
    const identity = aylaVimeoDeliveryIdentity(row);
    return identity.vimeoId === wanted
      || identity.resourceIds.includes(wanted)
      || exactReference(row.approvedResourceId, new Set([wanted]));
  });
  const aliases = new Set([wanted]);
  for (const row of [...resources, ...drafts]) {
    const identity = aylaVimeoDeliveryIdentity(row);
    [
      row.id,
      row.resourceId,
      row.approvedResourceId,
      row.vimeoId,
      identity.vimeoId,
      ...identity.resourceIds,
    ].filter(Boolean).forEach((value) => aliases.add(clean(value)));
  }
  return { wanted, resources, drafts, aliases };
}

export function previewAylaVimeoPermanentRemoval(db = {}, target = "") {
  const matched = matchingVimeoRows(db, target);
  if (!matched.wanted) {
    const error = new Error("video_id is required");
    error.statusCode = 400;
    throw error;
  }
  const notebookBlocks = collectionValues(db, "aylaNotebooks")
    .reduce((count, row) => count + (Array.isArray(row.blocks) ? row.blocks : [])
      .filter((block) => blockReferencesVideo(block, matched.aliases)).length, 0);
  const notebookVersionBlocks = collectionValues(db, "aylaNotebookVersions")
    .reduce((count, row) => count + (Array.isArray(row.blocks) ? row.blocks : [])
      .filter((block) => blockReferencesVideo(block, matched.aliases)).length, 0);
  const assignments = collectionValues(db, "aylaResourceAssignments").filter((row) => {
    const ids = cleanList([
      ...(row.resourceIds || row.resource_ids || []),
      ...(Array.isArray(row.items) ? row.items.map((item) => item?.resourceId || item?.resource_id) : []),
    ]);
    return ids.some((id) => matched.aliases.has(id));
  });
  const progress = collectionValues(db, "aylaVideoProgress").filter((row) =>
    [row.resourceId, row.resource_id, row.providerVideoId, row.provider_video_id, row.vimeoId, row.vimeo_id]
      .some((value) => exactReference(value, matched.aliases)));
  const controls = collectionValues(db, "aylaVimeoDeliveryControls").filter((row) =>
    cleanKey(row.scope) === "video" && matched.aliases.has(clean(row.target)));
  return {
    video_id: matched.wanted,
    aliases: [...matched.aliases].sort(),
    active_resources: matched.resources.length,
    catalog_drafts: matched.drafts.length,
    delivery_controls: controls.length,
    video_progress_rows: progress.length,
    assignments: assignments.length,
    notebook_blocks: notebookBlocks,
    notebook_version_blocks: notebookVersionBlocks,
    vimeo_asset_deleted: false,
    immutable_audit_history_preserved: true,
  };
}

export function applyAylaVimeoPermanentRemoval(db = {}, target = "") {
  const matched = matchingVimeoRows(db, target);
  const impact = previewAylaVimeoPermanentRemoval(db, target);
  const removedAssignmentIds = new Set();
  const counts = {
    active_resources: deleteCollectionRows(db, "aylaResources", (row) =>
      matched.resources.some((candidate) => clean(candidate.id) === clean(row.id))),
    catalog_drafts: deleteCollectionRows(db, "aylaVimeoCatalogDrafts", (row) =>
      matched.drafts.some((candidate) => clean(candidate.id) === clean(row.id))),
    delivery_controls: deleteCollectionRows(db, "aylaVimeoDeliveryControls", (row) =>
      cleanKey(row.scope) === "video" && matched.aliases.has(clean(row.target))),
    video_progress_rows: deleteCollectionRows(db, "aylaVideoProgress", (row) =>
      [row.resourceId, row.resource_id, row.providerVideoId, row.provider_video_id, row.vimeoId, row.vimeo_id]
        .some((value) => exactReference(value, matched.aliases))),
    assignments: 0,
    notebook_blocks: 0,
    notebook_version_blocks: 0,
  };
  for (const notebook of collectionValues(db, "aylaNotebooks")) {
    if (!Array.isArray(notebook.blocks)) continue;
    const kept = notebook.blocks.filter((block) => !blockReferencesVideo(block, matched.aliases));
    counts.notebook_blocks += notebook.blocks.length - kept.length;
    if (kept.length !== notebook.blocks.length) {
      notebook.blocks = kept.map((block, index) => ({ ...block, order: index }));
      notebook.updatedAt = new Date().toISOString();
    }
  }
  for (const version of collectionValues(db, "aylaNotebookVersions")) {
    if (!Array.isArray(version.blocks)) continue;
    const kept = version.blocks.filter((block) => !blockReferencesVideo(block, matched.aliases));
    counts.notebook_version_blocks += version.blocks.length - kept.length;
    if (kept.length !== version.blocks.length) version.blocks = kept.map((block, index) => ({ ...block, order: index }));
  }
  for (const assignment of collectionValues(db, "aylaResourceAssignments")) {
    const originalIds = cleanList(assignment.resourceIds || assignment.resource_ids);
    const nextIds = originalIds.filter((id) => !matched.aliases.has(id));
    const originalItems = Array.isArray(assignment.items) ? assignment.items : [];
    const nextItems = originalItems.filter((item) =>
      !matched.aliases.has(clean(item?.resourceId || item?.resource_id)));
    if (nextIds.length === originalIds.length && nextItems.length === originalItems.length) continue;
    counts.assignments += 1;
    assignment.resourceIds = nextIds;
    assignment.items = nextItems;
    assignment.updatedAt = new Date().toISOString();
    if (!nextIds.length && !nextItems.length) {
      assignment.status = "permanently_removed";
      assignment.removedAt = assignment.updatedAt;
      removedAssignmentIds.add(clean(assignment.id));
    }
  }
  for (const plan of collectionValues(db, "aylaDailyPlans")) {
    if (Array.isArray(plan.assignmentIds)) {
      plan.assignmentIds = plan.assignmentIds.filter((id) => !removedAssignmentIds.has(clean(id)));
    }
    if (Array.isArray(plan.assignment_ids)) {
      plan.assignment_ids = plan.assignment_ids.filter((id) => !removedAssignmentIds.has(clean(id)));
    }
  }
  return {
    impact,
    removed: counts,
    aliases: [...matched.aliases].sort(),
  };
}
