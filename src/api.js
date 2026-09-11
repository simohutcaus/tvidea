// src/api.js
// YouTube Data API v3 layer: search.list -> videos.list, with a
// localStorage-backed cache to keep well inside the free 10,000 units/day
// quota (search.list costs 100 units per call; videos.list costs 1).

import { cacheGet, cacheSet, getApiKey } from "./storage.js";
import { MIN_SUBSCRIBERS, MIN_VIEWS, WEIGHT_MIN_LOG, WEIGHT_MAX_LOG } from "./config.js";

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const GAMING_CATEGORY_ID = "20";
const MIN_DURATION_SECONDS = 180;
const LONG_BUCKET_SHARE = 1 / 3;
const CHANNELS_PAGE_SIZE = 50;
// A video with an unknown subscriber count (hidden by the channel owner)
// still needs a quality bar -- require a higher view count in exchange for
// not knowing who's behind it.
const UNKNOWN_SUBS_MIN_VIEWS_MULTIPLIER = 5;
const UNKNOWN_SUBS_WEIGHT = 1.5;

export class ApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "ApiError";
    this.kind = kind; // "no-key" | "bad-key" | "quota" | "network" | "unknown"
  }
}

// Parses YouTube's contentDetails.duration (ISO-8601, e.g. "PT1H2M3S").
// Handles missing components (e.g. "PT45S") and non-PT forms like "P0D"
// (used for live/upcoming broadcasts with no fixed duration) by returning 0.
function parseISODuration(iso) {
  if (typeof iso !== "string") return 0;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseFloat(match[3] || "0");
  return Math.round(hours * 3600 + minutes * 60 + seconds);
}

// videoDuration semantics (YouTube API): "short" = under 4 min,
// "medium" = 4-20 min, "long" = over 20 min, "any" = no filter.
// The "short" bucket is deliberately never requested: it is where Shorts-style
// filler lives, and a new video every 70 seconds is churn rather than
// background noise. "medium" is the sweet spot for half-listening.
function pickDurationBucket(maxMinutes) {
  if (maxMinutes <= 4) return "short";
  if (maxMinutes <= 20) return "medium";
  // Above 20 the obvious choice, "any", is the wrong one: measured against the
  // live API it discards ~60% of what it fetches (hour-long playthroughs and
  // podcasts) to surface a handful of in-range videos. "medium" alone yields
  // everything but never exceeds 20 min, so the extra headroom goes unused.
  // Mixing them keeps yield high while still reaching into the 20-30 range.
  return Math.random() < LONG_BUCKET_SHARE ? "long" : "medium";
}

const SEARCH_ORDERS = ["relevance", "viewCount", "date"];

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

async function readErrorReason(response) {
  try {
    const json = await response.clone().json();
    const err = json && json.error;
    const first = err && Array.isArray(err.errors) ? err.errors[0] : null;
    return {
      reason: (first && first.reason) || "",
      message: (err && err.message) || (first && first.message) || "",
    };
  } catch {
    return { reason: "", message: "" };
  }
}

// Exhausting the daily search allowance does NOT come back as the documented
// 403/quotaExceeded -- observed live, it is HTTP 429 with reason
// "rateLimitExceeded". Mapping that to "unknown" would both hide the useful
// message and defeat the queue's fail-fast, so every quota shape is listed.
const QUOTA_REASONS = new Set([
  "quotaExceeded",
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);
const KEY_REASONS = new Set(["keyInvalid", "badRequest", "keyExpired"]);

function mapHttpError(status, reason, message) {
  if (QUOTA_REASONS.has(reason) || status === 429) {
    return new ApiError("quota", message || "YouTube API daily quota exceeded.");
  }
  if (KEY_REASONS.has(reason) || status === 400) {
    return new ApiError("bad-key", message || "The YouTube API key was rejected.");
  }
  if (status === 403) {
    return new ApiError("bad-key", message || "Access to the YouTube API was denied.");
  }
  return new ApiError("unknown", message || `YouTube API request failed (HTTP ${status}).`);
}

async function apiFetch(url, signal) {
  let response;
  try {
    response = await fetch(url, { signal });
  } catch (err) {
    if (err && err.name === "AbortError") throw err; // let caller handle cancellation
    throw new ApiError("network", "Could not reach the YouTube API. Check your connection.");
  }
  if (!response.ok) {
    const { reason, message } = await readErrorReason(response);
    throw mapHttpError(response.status, reason, message);
  }
  try {
    return await response.json();
  } catch {
    throw new ApiError("unknown", "The YouTube API returned an unreadable response.");
  }
}

// Caps subscriber count into a soft weight: 1k subs -> 1.0, 10k -> 2.0,
// 100k -> 3.0, 1M -> 4.0, and no higher above that. The cap at the top is
// the whole point -- it stops mega-channels (which measured live skew toward
// kids' content farms and clickbait for these queries) from dominating the
// feed the way a straight subscriber-count ranking would.
function subscriberWeight(subscribers) {
  const logValue = Math.log10(Math.max(1, subscribers));
  const clamped = Math.min(WEIGHT_MAX_LOG, Math.max(WEIGHT_MIN_LOG, logValue));
  return clamped - (WEIGHT_MIN_LOG - 1);
}

// One channels.list call per 50 unique channel ids (costs 1 quota unit per
// call, negligible next to search.list's 100). Returns a Map of
// channelId -> subscriber count, or `null` when the channel hides its count
// (statistics.hiddenSubscriberCount === true) -- unknown, never treated as 0.
async function fetchChannelSubscribers(channelIds, apiKey, signal) {
  const result = new Map();
  for (let i = 0; i < channelIds.length; i += CHANNELS_PAGE_SIZE) {
    const chunk = channelIds.slice(i, i + CHANNELS_PAGE_SIZE);
    const sortedIds = [...chunk].sort();
    const cacheKey = `chan:${simpleHash(sortedIds.join(","))}`;
    let items = cacheGet(cacheKey);
    if (!items) {
      const params = new URLSearchParams({
        part: "statistics",
        id: chunk.join(","),
        key: apiKey,
      });
      const json = await apiFetch(`${CHANNELS_URL}?${params.toString()}`, signal);
      items = json.items || [];
      cacheSet(cacheKey, items);
    }
    for (const item of items) {
      const stats = item.statistics || {};
      if (stats.hiddenSubscriberCount === true || stats.subscriberCount === undefined) {
        result.set(item.id, null);
        continue;
      }
      const n = parseInt(stats.subscriberCount, 10);
      result.set(item.id, Number.isFinite(n) ? n : null);
    }
  }
  return result;
}

export async function fetchVideos(query, maxMinutes, { signal } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new ApiError("no-key", "No YouTube API key is set.");
  }

  const order = SEARCH_ORDERS[Math.floor(Math.random() * SEARCH_ORDERS.length)];
  const durationBucket = pickDurationBucket(maxMinutes);
  const searchCacheKey = `search:${query}|${order}|${durationBucket}`;

  let searchItems = cacheGet(searchCacheKey);

  if (!searchItems) {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      q: query,
      maxResults: "25",
      videoEmbeddable: "true",
      videoSyndicated: "true",
      order,
      relevanceLanguage: "en",
      safeSearch: "none",
      // Category 20 = Gaming. Without it "game"/"highlights" queries drift
      // into football highlights, editing tutorials and gaming-drama
      // commentary. Costs almost no yield and cuts the off-topic results.
      videoCategoryId: GAMING_CATEGORY_ID,
      key: apiKey,
    });
    if (durationBucket !== "any") params.set("videoDuration", durationBucket);

    const json = await apiFetch(`${SEARCH_URL}?${params.toString()}`, signal);
    searchItems = (json.items || [])
      .filter((it) => it.id && it.id.videoId)
      .map((it) => ({ id: it.id.videoId }));
    cacheSet(searchCacheKey, searchItems);
  }

  if (searchItems.length === 0) return [];

  const ids = searchItems.map((it) => it.id);
  const videosCacheKey = `videos:${simpleHash(ids.join(","))}`;
  let videoItems = cacheGet(videosCacheKey);

  if (!videoItems) {
    // statistics is free here: videos.list costs 1 quota unit regardless of
    // how many parts are requested, and it's what supplies viewCount below.
    const params = new URLSearchParams({
      part: "contentDetails,snippet,status,statistics",
      id: ids.join(","),
      key: apiKey,
    });
    const json = await apiFetch(`${VIDEOS_URL}?${params.toString()}`, signal);
    videoItems = json.items || [];
    cacheSet(videosCacheKey, videoItems);
  }

  // Anything under ~3 min is clip-churn for a channel meant to run unattended.
  // Only honour that floor when the cap leaves room for it.
  const minSeconds = maxMinutes > 4 ? MIN_DURATION_SECONDS : 60;

  const candidates = [];
  for (const item of videoItems) {
    const status = item.status || {};
    const durationSeconds = parseISODuration(item.contentDetails && item.contentDetails.duration);
    if (status.embeddable !== true) continue;
    if (status.privacyStatus !== "public") continue;
    if (!(durationSeconds > 0)) continue;
    if (durationSeconds > maxMinutes * 60) continue;
    if (durationSeconds < minSeconds) continue;
    const title = (item.snippet && item.snippet.title) || "Untitled";
    // Shorts land at exactly 1:00 and clear the floor above; the tag is the
    // only reliable marker the API exposes.
    if (/#shorts?\b/i.test(title)) continue;
    const viewCountRaw = item.statistics && item.statistics.viewCount;
    const viewCount = viewCountRaw !== undefined ? parseInt(viewCountRaw, 10) : 0;
    candidates.push({
      id: item.id,
      title,
      channelId: (item.snippet && item.snippet.channelId) || "",
      channelTitle: (item.snippet && item.snippet.channelTitle) || "",
      durationSeconds,
      viewCount: Number.isFinite(viewCount) ? viewCount : 0,
    });
  }

  if (candidates.length === 0) return [];

  const uniqueChannelIds = [...new Set(candidates.map((c) => c.channelId).filter(Boolean))];
  let subscriberMap = null; // null = subscriber data unavailable for this whole batch
  try {
    subscriberMap = await fetchChannelSubscribers(uniqueChannelIds, apiKey, signal);
  } catch (err) {
    if (err && err.name === "AbortError") throw err; // let caller handle cancellation
    // A quality signal going missing must never take the feed down: fall
    // back to treating every subscriber count as unknown.
    subscriberMap = null;
  }

  const results = [];
  for (const c of candidates) {
    const subscribers =
      subscriberMap && subscriberMap.has(c.channelId) ? subscriberMap.get(c.channelId) : null;

    if (subscribers !== null && subscribers < MIN_SUBSCRIBERS) continue;

    if (subscribers === null) {
      if (c.viewCount < MIN_VIEWS * UNKNOWN_SUBS_MIN_VIEWS_MULTIPLIER) continue;
    } else if (c.viewCount < MIN_VIEWS) {
      continue;
    }

    const weight = subscribers === null ? UNKNOWN_SUBS_WEIGHT : subscriberWeight(subscribers);

    results.push({
      id: c.id,
      title: c.title,
      channelTitle: c.channelTitle,
      durationSeconds: c.durationSeconds,
      subscribers,
      weight,
    });
  }
  return results;
}
