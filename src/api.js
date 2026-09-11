// src/api.js
// YouTube Data API v3 layer: search.list -> videos.list, with a
// localStorage-backed cache to keep well inside the free 10,000 units/day
// quota (search.list costs 100 units per call; videos.list costs 1).

import { cacheGet, cacheSet, getApiKey } from "./storage.js";

const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const GAMING_CATEGORY_ID = "20";
const MIN_DURATION_SECONDS = 180;

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
  return "any";
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

function mapHttpError(status, reason, message) {
  if (reason === "keyInvalid" || reason === "badRequest" || status === 400 || status === 403) {
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return new ApiError("quota", message || "YouTube API daily quota exceeded.");
    }
    if (reason === "keyInvalid" || reason === "badRequest" || status === 400) {
      return new ApiError("bad-key", message || "The YouTube API key was rejected.");
    }
    return new ApiError("bad-key", message || "Access to the YouTube API was denied.");
  }
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
    return new ApiError("quota", message || "YouTube API daily quota exceeded.");
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
    const params = new URLSearchParams({
      part: "contentDetails,snippet,status",
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

  const results = [];
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
    results.push({
      id: item.id,
      title,
      channelTitle: (item.snippet && item.snippet.channelTitle) || "",
      durationSeconds,
    });
  }
  return results;
}
