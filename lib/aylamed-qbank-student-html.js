import { parseFragment } from "parse5";
import { extractMediaReferences, extractExternalVideoReferences, mediaMatchKeys, normalizeMediaReferencePath } from "./content-import-adapter.js";

function descendants(root) {
  const result = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    result.push(node);
    pending.push(...(node.childNodes || []));
    if (node.content) pending.push(node.content); // Template contents have a separate root.
  }
  return result;
}

function textContent(node) {
  return descendants(node).filter((child) => child.nodeName === "#text")
    .reverse().map((child) => child.value || "").join("").replace(/\s+/g, "").toLowerCase();
}

/**
 * Student-only projection of imported provider hint widgets. Never persist this
 * result: the complete imported stem remains the admin/classification evidence.
 * A real HTML parser identifies nested nodes; source offsets remove only their
 * original spans, avoiding serialization changes to clinical tables and text.
 */
export function projectStudentQbankStem(value) {
  const original = String(value || "");
  // Most stems do not need a DOM. An encoded id still contains an id attribute.
  if (!/\bid\s*=/i.test(original)) return { html: original, removedHtml: "" };
  const nodes = descendants(parseFragment(original, { sourceCodeLocationInfo: true }));
  const hints = nodes.filter((node) => node.attrs?.some((attr) =>
    attr.name === "id" && attr.value.trim().toLowerCase() === "hintdiv"));
  if (!hints.length) return { html: original, removedHtml: "" };
  const controls = nodes.filter((node) => ["button", "strong", "a", "span"].includes(node.tagName)
    && textContent(node) === "showhint");
  const spans = [...hints, ...controls].map((node) => node.sourceCodeLocation)
    .map((location) => [location?.startOffset, location?.endOffset]);
  // A recognized widget without a reliable range must not fall back to exposing
  // its contents. Normal parser-created elements cannot have the explicit id.
  if (spans.some(([start, end]) => !Number.isInteger(start) || !Number.isInteger(end) || end <= start)) {
    return { html: "", removedHtml: original };
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push([...span]);
  }
  let cursor = 0;
  let html = "";
  let removedHtml = "";
  for (const [start, end] of merged) {
    html += original.slice(cursor, start);
    removedHtml += original.slice(start, end);
    cursor = end;
  }
  return { html: html + original.slice(cursor), removedHtml };
}

function references(html) {
  return {
    paths: extractMediaReferences(html).map((value) => value.toLowerCase()),
    videos: new Set(extractExternalVideoReferences(html).map((video) => `${video.provider}:${video.provider_id}`)),
  };
}

function matchStrength(item, refs) {
  if (refs.videos.has(`${item.provider || "vimeo"}:${item.provider_id || ""}`)
    || refs.videos.has(String(item.ref || ""))) return 3;
  const itemPath = normalizeMediaReferencePath(item.ref).toLowerCase();
  if (!itemPath) return 0;
  const itemKeys = new Set(mediaMatchKeys(itemPath));
  let strength = 0;
  for (const sourcePath of refs.paths) {
    if (sourcePath === itemPath) return 3;
    if (sourcePath.endsWith(`/${itemPath}`) || itemPath.endsWith(`/${sourcePath}`)) strength = Math.max(strength, 2);
    else {
      const sourceDirectory = sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1);
      const itemDirectory = itemPath.slice(0, itemPath.lastIndexOf("/") + 1);
      // Filename aliases never identify a different directory's figure. An
      // exact hint/path match must beat a same-basename ordinary image.
      if (sourceDirectory && itemDirectory && sourceDirectory !== itemDirectory) continue;
      if (mediaMatchKeys(sourcePath).some((key) => itemKeys.has(key))) strength = Math.max(strength, 1);
    }
  }
  return strength;
}

/** Separate media galleries must not reintroduce an image/video removed above. */
export function projectStudentQbankHintMedia(question, stem, reveal) {
  if (!stem.removedHtml) return { media: question.media, videos: question.videos };
  const removed = references(stem.removedHtml);
  const choices = Array.isArray(question.answers) ? question.answers : [];
  const remaining = references([stem.html, ...choices.map((row) => row.text_html ?? row.textHtml ?? "")].join("\n"));
  const explanation = references(question.explanation_html);
  const project = (items) => (Array.isArray(items) ? items : []).flatMap((item) => {
    if (String(item.placement || "explanation") !== "question") return [item];
    const hiddenStrength = matchStrength(item, removed);
    if (!hiddenStrength || matchStrength(item, remaining) >= hiddenStrength) return [item];
    // A shared explanation image is released at the ordinary answer boundary,
    // and is no longer rendered as question media above the choices.
    return reveal && matchStrength(item, explanation) >= hiddenStrength ? [{ ...item, placement: "explanation" }] : [];
  });
  return { media: project(question.media), videos: project(question.videos) };
}
