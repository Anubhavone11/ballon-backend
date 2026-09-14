// utils/serverCache.js
//
// Minimal in-memory TTL cache. Zero dependencies, safe for a single Node
// process. If you ever run multiple instances/pods behind a load balancer,
// swap this for Redis (same get/set/clear API) so all instances share state.

const store = new Map();

function getCache(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value, ttlMs = 60_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Call this from create/update/delete product handlers so stale list
// results aren't served after a write. Pass a prefix like 'products:'
// to clear just that namespace, or nothing to clear everything.
function clearCache(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

module.exports = { getCache, setCache, clearCache };