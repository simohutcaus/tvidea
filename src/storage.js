// src/storage.js
// Thin localStorage wrapper. Every call is try/catch-guarded so that
// private-mode / storage-disabled browsers degrade to in-memory defaults
// instead of throwing and breaking the app.

import { DEFAULT_MAX_MINUTES, MAX_MINUTES_OPTIONS, CACHE_TTL_MS } from "./config.js";

const PREFIX = "tvidea.";
const KEY_API_KEY = PREFIX + "apiKey";
const KEY_MAX_MINUTES = PREFIX + "maxMinutes";
const KEY_VOLUME = PREFIX + "volume";
const KEY_MUTED = PREFIX + "muted";
const CACHE_PREFIX = PREFIX + "cache.";

// In-memory fallback store, used when localStorage throws or is unavailable.
const memoryStore = new Map();

function hasLocalStorage() {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function rawGet(key) {
  try {
    if (hasLocalStorage()) return window.localStorage.getItem(key);
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  } catch {
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  }
}

function rawSet(key, value) {
  try {
    if (hasLocalStorage()) {
      window.localStorage.setItem(key, value);
      return true;
    }
    memoryStore.set(key, value);
    return true;
  } catch (err) {
    memoryStore.set(key, value);
    throw err;
  }
}

function rawRemove(key) {
  try {
    if (hasLocalStorage()) window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
  memoryStore.delete(key);
}

// ---- API key -----------------------------------------------------------

export function getApiKey() {
  const v = rawGet(KEY_API_KEY);
  return v && v.length ? v : null;
}

export function setApiKey(k) {
  if (typeof k !== "string" || !k.trim()) return;
  try {
    rawSet(KEY_API_KEY, k.trim());
  } catch {
    // swallow quota/storage errors -- key still lives in memoryStore
  }
}

export function clearApiKey() {
  rawRemove(KEY_API_KEY);
}

// ---- Max minutes ---------------------------------------------------------

export function getMaxMinutes() {
  const raw = rawGet(KEY_MAX_MINUTES);
  const n = raw ? parseInt(raw, 10) : NaN;
  return MAX_MINUTES_OPTIONS.includes(n) ? n : DEFAULT_MAX_MINUTES;
}

export function setMaxMinutes(n) {
  const val = MAX_MINUTES_OPTIONS.includes(n) ? n : DEFAULT_MAX_MINUTES;
  try {
    rawSet(KEY_MAX_MINUTES, String(val));
  } catch {
    // ignore
  }
}

// ---- Volume ---------------------------------------------------------------

export function getVolume() {
  const raw = rawGet(KEY_VOLUME);
  const n = raw !== null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 70;
}

export function setVolume(v) {
  const val = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  try {
    rawSet(KEY_VOLUME, String(val));
  } catch {
    // ignore
  }
}

// ---- Muted ------------------------------------------------------------

export function getMuted() {
  return rawGet(KEY_MUTED) === "1";
}

export function setMuted(b) {
  try {
    rawSet(KEY_MUTED, b ? "1" : "0");
  } catch {
    // ignore
  }
}

// ---- Cache (search & videos.list responses) ----------------------------

function cacheKeyFor(key) {
  return CACHE_PREFIX + key;
}

export function cacheGet(key) {
  const raw = rawGet(cacheKeyFor(key));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.ts !== "number") return null;
    if (Date.now() - parsed.ts < CACHE_TTL_MS) return parsed.value;
    return null;
  } catch {
    return null;
  }
}

function allCacheKeys() {
  const keys = [];
  try {
    if (hasLocalStorage()) {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
      }
      return keys;
    }
  } catch {
    // fall through to memory
  }
  for (const k of memoryStore.keys()) {
    if (k.startsWith(CACHE_PREFIX)) keys.push(k);
  }
  return keys;
}

// Evicts the oldest cache entries (by stored ts) to make room, then retries
// the write once. Keeps the app usable even when localStorage is near its
// quota (cached YouTube responses can be sizeable).
function evictOldestCacheEntries(count) {
  const entries = [];
  for (const k of allCacheKeys()) {
    const raw = rawGet(k);
    let ts = 0;
    try {
      ts = JSON.parse(raw)?.ts ?? 0;
    } catch {
      ts = 0;
    }
    entries.push({ key: k, ts });
  }
  entries.sort((a, b) => a.ts - b.ts);
  const toEvict = entries.slice(0, count);
  for (const e of toEvict) rawRemove(e.key);
  return toEvict.length;
}

export function cacheSet(key, value) {
  const payload = JSON.stringify({ ts: Date.now(), value });
  const fullKey = cacheKeyFor(key);
  try {
    rawSet(fullKey, payload);
  } catch (err) {
    const isQuotaError =
      err &&
      (err.name === "QuotaExceededError" ||
        err.code === 22 ||
        err.code === 1014 ||
        /quota/i.test(err.message || ""));
    if (!isQuotaError) return;
    const evicted = evictOldestCacheEntries(Math.max(5, Math.ceil(allCacheKeys().length / 4)));
    if (evicted === 0) return;
    try {
      rawSet(fullKey, payload);
    } catch {
      // give up silently -- caching is a best-effort optimization
    }
  }
}
