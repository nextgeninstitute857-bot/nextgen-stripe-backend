const EDITION_PATTERN = /(?:^|[^0-9])(20[0-9]{2})(?![0-9])/g;
const COMPACT_STEP1_EDITION_PATTERN = /step1(20[0-9]{2})(?![0-9])/gi;

export function normalizeContentEdition(value) {
  const clean = String(value || "").trim();
  return /^20[0-9]{2}$/.test(clean) ? clean : "";
}

export function contentPathEditions(value) {
  const editions = new Set();
  const clean = String(value || "");
  for (const match of clean.matchAll(EDITION_PATTERN)) {
    editions.add(match[1]);
  }
  for (const match of clean.matchAll(COMPACT_STEP1_EDITION_PATTERN)) {
    editions.add(match[1]);
  }
  return [...editions];
}

export function contentPathMatchesEdition(value, edition) {
  const cleanEdition = normalizeContentEdition(edition);
  if (!cleanEdition) return false;
  return contentPathEditions(value).includes(cleanEdition);
}

export function contentReferenceMatchesEdition(reference = {}, edition) {
  const cleanEdition = normalizeContentEdition(edition);
  if (!cleanEdition) return false;
  return contentPathMatchesEdition(reference.sourceSnapshot, cleanEdition);
}

export function filterContentReferencesByEdition(references = [], edition) {
  const cleanEdition = normalizeContentEdition(edition);
  if (!cleanEdition) return [];
  return (Array.isArray(references) ? references : [])
    .filter((reference) => contentReferenceMatchesEdition(reference, cleanEdition));
}

export function filterContentAssetsByEdition(assets = [], edition) {
  const cleanEdition = normalizeContentEdition(edition);
  if (!cleanEdition) return [];
  return (Array.isArray(assets) ? assets : [])
    .filter((asset) => contentPathMatchesEdition(asset?.originalName, cleanEdition));
}
