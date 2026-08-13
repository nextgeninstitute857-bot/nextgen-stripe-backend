export function createBoundedSnapshotCache({
  ttlMs = 1250,
  maxEntries = 64,
  now = () => Date.now(),
} = {}) {
  const safeTtlMs = Math.max(100, Math.min(5000, Number(ttlMs) || 1250));
  const safeMaxEntries = Math.max(1, Math.min(256, Number(maxEntries) || 64));
  const snapshots = new Map();
  const inFlight = new Map();
  let generation = 0;

  function trim() {
    while (snapshots.size > safeMaxEntries) {
      snapshots.delete(snapshots.keys().next().value);
    }
  }

  async function read(key, load) {
    const cacheKey = String(key || "");
    if (!cacheKey) throw new Error("Snapshot cache key is required");
    if (typeof load !== "function") throw new Error("Snapshot loader is required");

    const current = snapshots.get(cacheKey);
    const timestamp = now();
    if (current && current.generation === generation && current.expiresAt > timestamp) {
      return current.value;
    }
    if (current) snapshots.delete(cacheKey);

    const running = inFlight.get(cacheKey);
    if (running && running.generation === generation) return running.promise;

    const readGeneration = generation;
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (generation === readGeneration) {
          snapshots.set(cacheKey, {
            generation: readGeneration,
            expiresAt: now() + safeTtlMs,
            value,
          });
          trim();
        }
        return value;
      })
      .finally(() => {
        if (inFlight.get(cacheKey)?.promise === promise) inFlight.delete(cacheKey);
      });

    inFlight.set(cacheKey, { generation: readGeneration, promise });
    return promise;
  }

  function invalidate() {
    generation += 1;
    snapshots.clear();
  }

  function status() {
    return {
      ttl_ms: safeTtlMs,
      max_entries: safeMaxEntries,
      cached_entries: snapshots.size,
      in_flight: inFlight.size,
      generation,
    };
  }

  return { read, invalidate, status };
}
