// src/config.js
// Static configuration: the feed's query pool and tunables.
// No user data lives here -- see storage.js for that.

export const FEED_QUERIES = [
  // retro
  "retro game review",
  "NES hidden gems",
  "SNES retrospective",
  "Nintendo 64 deep dive",
  "PS1 obscure games",
  "arcade game history",
  "Sega Genesis review",
  "retro gaming documentary",
  "Game Boy games retrospective",
  "classic PC gaming history",
  "forgotten video games",
  "retro console hardware explained",
  // speedrun
  "speedrun world record",
  "GDQ speedrun highlight",
  "any% speedrun explained",
  "speedrun commentary",
  "esports best plays",
  "speedrun history",
  "EVO moment fighting game",
  "tool assisted speedrun",
  "speedrun glitch showcase",
  "how speedrunners break games",
  "world record progression",
  // reviews
  "video game review",
  "video game essay",
  "gaming news roundup",
  "why this game works",
  "game design analysis",
  "indie game review",
  "game retrospective essay",
  "video game criticism",
  "hidden mechanics explained games",
  "what makes a good game",
  // devs
  "game dev postmortem",
  "how this game was made",
  "indie devlog",
  "game development breakdown",
  "game engine explained",
  "game physics programming explained",
  "game art pipeline",
  "procedural generation games explained",
  "solo game developer story",
  "game programming tricks"
];

export const DEFAULT_MAX_MINUTES = 30;
export const MAX_MINUTES_OPTIONS = [5, 10, 15, 20, 30];
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h -- search.list costs 100 quota units

// ---- Quality weighting ----------------------------------------------------
// Measured against the live API over 132 videos / 109 channels, subscriber
// counts are almost flat across bands. Two things fall out of that:
//   - under ~1k subs is genuine junk (0-8 subscriber channels, 8-85 view
//     student-coursework-grade uploads) -- worth dropping outright.
//   - the very top is ALSO bad here: the highest-subscriber results were kids'
//     content farms and clickbait, not what "quality" means for this feed.
// So subscriber count is used as a capped, soft weight -- never a hard
// ranking. See queue.js for the sampling and api.js for the weight math.
export const MIN_SUBSCRIBERS = 1000; // removes the 0-8 sub junk tier (keeps ~77%)
export const MIN_VIEWS = 1000; // removes 8-view uploads
export const WEIGHT_MIN_LOG = 3; // 10^3 = 1k subs  -> weight 1
export const WEIGHT_MAX_LOG = 6; // 10^6 = 1M subs  -> weight 4, and no more above that
