import path from "node:path";
import { mediaMatchKeys, normalizeMediaReferencePath } from "./content-import-adapter.js";

function exactMediaPath(value) {
  return normalizeMediaReferencePath(value)
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function mediaSnapshotKey(value) {
  const clean = String(value || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  const parts = clean.split("/").filter(Boolean);
  let candidate = parts.find((part) => /20\d{2}/.test(part))
    || parts[0]
    || "";
  candidate = candidate
    .replace(/_(?:questions|answers)(?:\.json)?$/i, "")
    .replace(/\.(?:json|zip)$/i, "")
    .replace(/september/g, "sept")
    .replace(/july/g, "jul")
    .replace(/january/g, "jan")
    .replace(/[^a-z0-9]/g, "");
  return /20\d{2}/.test(candidate) ? candidate : "";
}

function sameMediaSnapshot(left, right) {
  const leftKey = mediaSnapshotKey(left);
  const rightKey = mediaSnapshotKey(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey;
  const longer = leftKey.length > rightKey.length ? leftKey : rightKey;
  return shorter.length >= 8 && longer.endsWith(shorter);
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

function snapshotCandidates(candidates, snapshots = []) {
  const configured = [...new Set((Array.isArray(snapshots) ? snapshots : [snapshots])
    .map((value) => String(value || ""))
    .filter(Boolean))];
  if (!configured.length) return [];
  return uniqueAssets(candidates.filter((asset) =>
    configured.some((snapshot) => sameMediaSnapshot(asset.originalName, snapshot))));
}

function resolveCandidateSet(candidates, reference = {}) {
  const unique = uniqueAssets(candidates);
  if (unique.length <= 1) {
    return { resolved: unique[0] || null, ambiguous: [] };
  }

  const preferredSnapshot = snapshotCandidates(unique, reference.sourceSnapshot);
  if (preferredSnapshot.length === 1) {
    return { resolved: preferredSnapshot[0], ambiguous: [] };
  }
  if (preferredSnapshot.length > 1) {
    return { resolved: null, ambiguous: preferredSnapshot };
  }

  const aliasSnapshots = snapshotCandidates(unique, reference.sourceSnapshotAliases);
  if (aliasSnapshots.length === 1) {
    return { resolved: aliasSnapshots[0], ambiguous: [] };
  }
  return {
    resolved: null,
    ambiguous: aliasSnapshots.length ? aliasSnapshots : unique,
  };
}

export function createReferencedAssetMatcher(assets = [], {
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

  return (references = []) => {
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
        const pathResolution = resolveCandidateSet(candidates, reference);
        if (pathResolution.resolved) {
          resolved = pathResolution.resolved;
          break;
        }
        pathAmbiguities.push(...pathResolution.ambiguous);
      }

      if (!resolved && !pathAmbiguities.length) {
        const exact = uniqueAssets(
          byExact.get(path.basename(String(reference.mediaRef || "")).toLowerCase()) || [],
        );
        const exactResolution = resolveCandidateSet(exact, reference);
        resolved = exactResolution.resolved;
        pathAmbiguities.push(...exactResolution.ambiguous);
      }

      if (!resolved && !pathAmbiguities.length) {
        const keyed = [];
        for (const key of mediaMatchKeys(reference.mediaRef)) keyed.push(...(byKey.get(key) || []));
        const keyedResolution = resolveCandidateSet(keyed, reference);
        resolved = keyedResolution.resolved;
        pathAmbiguities.push(...keyedResolution.ambiguous);
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
  };
}

export function matchReferencedAssets(references = [], assets = [], options = {}) {
  return createReferencedAssetMatcher(assets, options)(references);
}
