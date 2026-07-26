import path from "node:path";
import { mediaMatchKeys, normalizeMediaReferencePath } from "./content-import-adapter.js";

function exactMediaPath(value) {
  return normalizeMediaReferencePath(value)
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function pathSuffixes(value) {
  const parts = exactMediaPath(value).split("/").filter(Boolean);
  if (parts.length < 2) return [];
  return Array.from({ length: parts.length - 1 }, (_, index) =>
    parts.slice(index).join("/"));
}

function assetIdentity(asset = {}) {
  return String(
    asset.sha256
    || asset.objectKey
    || asset.entryName
    || asset.providerId
    || asset.originalName
    || "",
  );
}

function append(index, key, asset) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(asset);
}

function uniqueAssets(assets = []) {
  const unique = new Map();
  for (const asset of assets) {
    const identity = assetIdentity(asset);
    if (identity && !unique.has(identity)) unique.set(identity, asset);
  }
  return [...unique.values()];
}

function referencePaths(reference = {}) {
  const configured = Array.isArray(reference.matchPaths)
    ? reference.matchPaths
    : reference.matchPath
      ? [reference.matchPath]
      : [];
  return [...new Set([
    ...configured,
    reference.mediaRef,
  ].map(exactMediaPath).filter(Boolean))];
}

export function matchReferencedAssets(references = [], assets = [], {
  matchField = "asset",
} = {}) {
  const byKey = new Map();
  const byExact = new Map();
  const byPath = new Map();
  const bySuffix = new Map();
  for (const asset of assets) {
    for (const key of mediaMatchKeys(asset.originalName)) append(byKey, key, asset);
    append(byExact, path.basename(String(asset.originalName || "")).toLowerCase(), asset);
    append(byPath, exactMediaPath(asset.originalName), asset);
    for (const suffix of pathSuffixes(asset.originalName)) append(bySuffix, suffix, asset);
  }

  const matches = [];
  const missing = [];
  const ambiguous = [];
  const used = new Set();
  for (const reference of references) {
    let resolved = null;
    const pathAmbiguities = [];
    const paths = referencePaths(reference);
    for (const candidatePath of paths) {
      if (!candidatePath.includes("/")) continue;
      const candidates = uniqueAssets([
        ...(byPath.get(candidatePath) || []),
        ...(bySuffix.get(candidatePath) || []),
      ]);
      if (candidates.length === 1) {
        resolved = candidates[0];
        break;
      }
      if (candidates.length > 1) pathAmbiguities.push(...candidates);
    }

    if (!resolved && !pathAmbiguities.length) {
      const exact = uniqueAssets(
        byExact.get(path.basename(String(reference.mediaRef || "")).toLowerCase()) || [],
      );
      if (exact.length === 1) resolved = exact[0];
      else if (exact.length > 1) pathAmbiguities.push(...exact);
    }

    if (!resolved && !pathAmbiguities.length) {
      const keyed = [];
      for (const key of mediaMatchKeys(reference.mediaRef)) keyed.push(...(byKey.get(key) || []));
      const candidates = uniqueAssets(keyed);
      if (candidates.length === 1) resolved = candidates[0];
      else if (candidates.length > 1) pathAmbiguities.push(...candidates);
    }

    if (resolved) {
      used.add(assetIdentity(resolved));
      matches.push({ ...reference, [matchField]: resolved });
    } else if (pathAmbiguities.length) {
      ambiguous.push({
        ...reference,
        candidates: uniqueAssets(pathAmbiguities).map((asset) => asset.originalName),
      });
    } else {
      missing.push(reference);
    }
  }

  return {
    matches,
    missing,
    ambiguous,
    unreferenced: assets.filter((asset) => !used.has(assetIdentity(asset))),
  };
}
