import path from "node:path";

const VERIFIED_RIGHTS = new Set(["authorized", "admin_verified", "licensed", "owned"]);
const MAX_BOOK_MEDIA_REFERENCES = 100_000;

function cleanString(value = "", maximum = 1_000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

function pageIdentity(page = {}) {
  const pdfPage = Number(page.pdfPage ?? page.pdf_page);
  if (Number.isInteger(pdfPage) && pdfPage > 0) return `pdf:${pdfPage}`;
  const printed = cleanString(page.printedPage ?? page.printed_page, 80);
  if (printed) return `printed:${printed.toLowerCase()}`;
  return cleanString(page.key, 100).toLowerCase();
}

function normalizeMatchPaths(reference = {}) {
  return [...new Set([
    ...(Array.isArray(reference.matchPaths) ? reference.matchPaths : []),
    ...(Array.isArray(reference.match_paths) ? reference.match_paths : []),
    reference.matchPath,
    reference.match_path,
  ].map((value) => cleanString(value, 1_000)).filter(Boolean))].slice(0, 12);
}

function referenceIdentity(reference = {}) {
  return cleanString(reference.id || reference.referenceId || reference.reference_id, 160);
}

function mediaMatchIdentity(reference = {}) {
  return [
    cleanString(reference.resourceId || reference.resource_id, 220),
    cleanString(reference.pageKey || reference.page_key, 120),
    referenceIdentity(reference),
  ].join("\u0000");
}

export function authorizedBookMediaResources(resources = [], bookKey = "") {
  const wanted = cleanString(bookKey, 180).toLowerCase();
  return (Array.isArray(resources) ? resources : []).filter((resource) => {
    const type = cleanString(resource.type, 80).toLowerCase();
    const folder = cleanString(resource.folderId || resource.folder_id, 180).toLowerCase();
    const access = cleanString(resource.sourceAccessMode || resource.source_access_mode, 80).toLowerCase();
    const rights = cleanString(resource.authorizationStatus || resource.authorization_status, 80).toLowerCase();
    return type === "book" && folder === wanted && access === "protected" && VERIFIED_RIGHTS.has(rights);
  });
}

export function collectBookMediaReferences(resources = [], { bookKey = "" } = {}) {
  const eligible = authorizedBookMediaResources(resources, bookKey);
  const references = [];
  for (const resource of eligible) {
    const pages = Array.isArray(resource.readerPages)
      ? resource.readerPages
      : Array.isArray(resource.reader_pages) ? resource.reader_pages : [];
    for (const page of pages) {
      const pageKey = pageIdentity(page);
      const rows = Array.isArray(page.mediaReferences)
        ? page.mediaReferences
        : Array.isArray(page.media_references) ? page.media_references : [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || {};
        const mediaRef = cleanString(row.ref || row.mediaRef || row.media_ref, 1_000);
        if (!mediaRef) continue;
        const id = referenceIdentity(row) || `figure-${index + 1}`;
        references.push({
          resourceId: String(resource.id),
          pageKey,
          referenceId: id,
          mediaRef,
          matchPaths: normalizeMatchPaths(row),
          alt: cleanString(row.alt || row.label, 500),
          caption: cleanString(row.caption, 1_000),
          placement: cleanString(row.placement || "inline", 80).toLowerCase() || "inline",
          order: Math.max(0, Number(row.order ?? index) || 0),
        });
        if (references.length > MAX_BOOK_MEDIA_REFERENCES) {
          throw Object.assign(new Error("Book media import exceeds the reference safety limit"), { statusCode: 413 });
        }
      }
    }
  }
  return { resources: eligible, references };
}

function contentType(asset = {}) {
  const direct = cleanString(asset.contentType || asset.content_type, 120);
  if (direct) return direct;
  const extension = path.extname(String(asset.originalName || "")).toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  return "image/*";
}

export function applyBookMediaMatches(resources = [], report = {}, {
  bookKey = "",
  importedAt = new Date().toISOString(),
} = {}) {
  const matches = new Map((Array.isArray(report.matches) ? report.matches : []).map((match) => [
    mediaMatchIdentity(match),
    match,
  ]));
  const unresolved = new Set([
    ...(Array.isArray(report.missing) ? report.missing : []),
    ...(Array.isArray(report.ambiguous) ? report.ambiguous : []),
  ].map(mediaMatchIdentity));
  let references = 0;
  let linked = 0;
  const updated = authorizedBookMediaResources(resources, bookKey).map((resource) => {
    let resourceReferences = 0;
    let resourceLinked = 0;
    const inputPages = Array.isArray(resource.readerPages)
      ? resource.readerPages
      : Array.isArray(resource.reader_pages) ? resource.reader_pages : [];
    const readerPages = inputPages.map((page) => {
      const pageKey = pageIdentity(page);
      const pageReferences = Array.isArray(page.mediaReferences)
        ? page.mediaReferences
        : Array.isArray(page.media_references) ? page.media_references : [];
      const media = [];
      for (let index = 0; index < pageReferences.length; index += 1) {
        const reference = pageReferences[index] || {};
        const normalized = {
          resourceId: String(resource.id),
          pageKey,
          referenceId: referenceIdentity(reference) || `figure-${index + 1}`,
        };
        resourceReferences += 1;
        references += 1;
        const match = matches.get(mediaMatchIdentity(normalized));
        if (!match?.asset?.objectKey) continue;
        resourceLinked += 1;
        linked += 1;
        media.push({
          id: normalized.referenceId,
          ref: cleanString(reference.ref || reference.mediaRef || reference.media_ref, 1_000),
          alt: cleanString(reference.alt || reference.label || match.alt, 500),
          caption: cleanString(reference.caption || match.caption, 1_000),
          placement: cleanString(reference.placement || match.placement || "inline", 80).toLowerCase(),
          order: Math.max(0, Number(reference.order ?? match.order ?? index) || 0),
          kind: "image",
          objectKey: String(match.asset.objectKey),
          contentType: contentType(match.asset),
          sha256: cleanString(match.asset.sha256, 80),
          sizeBytes: Math.max(0, Number(match.asset.sizeBytes || 0)),
        });
      }
      return { ...page, media };
    });
    const missing = Math.max(0, resourceReferences - resourceLinked);
    return {
      ...resource,
      readerPages,
      requiredMediaMissingCount: missing,
      mediaReferenceCount: resourceReferences,
      mediaDeliveryLinkedCount: resourceLinked,
      mediaDeliveryReady: resourceReferences === resourceLinked,
      sourceData: {
        ...(resource.sourceData && typeof resource.sourceData === "object" ? resource.sourceData : {}),
        delivery_media_ready: resourceReferences === resourceLinked,
        delivery_media_linked_count: resourceLinked,
        delivery_media_missing_count: missing,
        delivery_media_imported_at: importedAt,
      },
      updatedAt: importedAt,
    };
  });
  return {
    resources: updated,
    counts: {
      resources: updated.length,
      references,
      linked,
      missing: Math.max(0, references - linked),
      ambiguous: Array.isArray(report.ambiguous) ? report.ambiguous.length : 0,
      unresolved: unresolved.size,
      deliveryReadyResources: updated.filter((resource) => resource.mediaDeliveryReady).length,
    },
  };
}
