// src/queue.js
// Single-feed video queue: buffers upcoming videos, refills from the API
// in the background, and avoids repeats for the life of the session.

import { fetchVideos, ApiError } from "./api.js";

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Weighted sampling without replacement (Efraimidis-Spirakis): give every
// video a random key raised to 1/weight, then sort descending by key. This is
// a *weighting*, not a ranking -- a higher-weight (more-subscribed) video has
// a better expected position, but every video, even weight 1, keeps a real
// chance at any slot. Sorting by subscriber count directly would surface the
// same handful of mega-channels every time, which is exactly what we don't
// want (see config.js for why the weight itself is capped).
function weightedShuffleInPlace(arr) {
  for (const v of arr) {
    const weight = v && typeof v.weight === "number" && v.weight > 0 ? v.weight : 1;
    v._sortKey = Math.random() ** (1 / weight);
  }
  arr.sort((a, b) => b._sortKey - a._sortKey);
  for (const v of arr) delete v._sortKey;
  return arr;
}

const REFILL_THRESHOLD = 3;
const MAX_QUERY_ATTEMPTS = 4; // 1 initial + up to 3 more

// A different search query cannot fix a rejected key or an exhausted quota,
// and each retry costs another 100 units -- fail fast on these instead.
const FATAL_ERROR_KINDS = new Set(["no-key", "bad-key", "quota"]);

export class Queue {
  constructor(queries) {
    this.queries = queries;
    this.buffer = [];
    this.seen = new Set(); // session-only, no persistence
    this._shuffledQueries = null;
    this._queryIndex = 0;
    this._refillPromise = null;
  }

  // Cycles through a shuffled copy of the query pool so every query gets
  // used before any repeats.
  _nextQuery() {
    if (!this._shuffledQueries || this._queryIndex >= this._shuffledQueries.length) {
      this._shuffledQueries = shuffleInPlace([...this.queries]);
      this._queryIndex = 0;
    }
    return this._shuffledQueries[this._queryIndex++];
  }

  async _doRefill(maxMinutes) {
    let attempts = 0;
    let lastError = null;
    let sawAnyRawVideos = false;

    while (attempts < MAX_QUERY_ATTEMPTS) {
      attempts++;
      const query = this._nextQuery();
      let videos;
      try {
        videos = await fetchVideos(query, maxMinutes);
      } catch (err) {
        lastError = err;
        if (err instanceof ApiError && FATAL_ERROR_KINDS.has(err.kind)) break;
        continue;
      }
      if (videos.length > 0) sawAnyRawVideos = true;
      const fresh = videos.filter(
        (v) => !this.seen.has(v.id) && !this.buffer.some((b) => b.id === v.id)
      );
      if (fresh.length > 0) {
        weightedShuffleInPlace(fresh);
        this.buffer.push(...fresh);
        return;
      }
    }

    if (this.buffer.length > 0) return;

    // Every fetched video had already been seen this session (small pool
    // exhausted) -- clear the seen set rather than stalling forever.
    const fatal = lastError instanceof ApiError && FATAL_ERROR_KINDS.has(lastError.kind);
    if (!fatal && sawAnyRawVideos && this.seen.size > 0) {
      this.seen.clear();
      try {
        const query = this._nextQuery();
        const videos = await fetchVideos(query, maxMinutes);
        const fresh = videos.filter((v) => !this.buffer.some((b) => b.id === v.id));
        if (fresh.length > 0) {
          weightedShuffleInPlace(fresh);
          this.buffer.push(...fresh);
          return;
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new ApiError("unknown", "No playable videos found right now.");
  }

  // Guards against concurrent refills -- callers share the same in-flight
  // promise instead of firing duplicate API requests.
  _refill(maxMinutes) {
    if (this._refillPromise) return this._refillPromise;
    this._refillPromise = this._doRefill(maxMinutes).finally(() => {
      this._refillPromise = null;
    });
    return this._refillPromise;
  }

  async next(maxMinutes) {
    if (this.buffer.length === 0) {
      await this._refill(maxMinutes);
    } else if (this.buffer.length < REFILL_THRESHOLD) {
      this.prefetch(maxMinutes);
    }

    if (this.buffer.length === 0) {
      throw new ApiError("unknown", "No playable videos found right now.");
    }

    const video = this.buffer.shift();
    this.seen.add(video.id);
    return video;
  }

  // Fire-and-forget top-up; callers don't await this and errors never
  // propagate -- the next explicit next() call will surface real failures.
  prefetch(maxMinutes) {
    this._refill(maxMinutes).catch(() => {});
  }

  reset() {
    this.buffer = [];
  }
}
