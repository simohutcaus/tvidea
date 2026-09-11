// src/config.js
// Static configuration: channels, query pools, and tunables.
// No user data lives here -- see storage.js for that.

export const CHANNELS = [
  {
    id: "retro",
    name: "RETRO",
    tagline: "Classic games, revisited",
    queries: [
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
      "retro console hardware explained"
    ]
  },
  {
    id: "speedrun",
    name: "SPEEDRUN",
    tagline: "Records, clips and insane plays",
    queries: [
      "speedrun world record",
      "GDQ speedrun highlight",
      "any% speedrun explained",
      "gaming highlights clips",
      "esports best plays",
      "insane gaming moments",
      "EVO moment fighting game",
      "tool assisted speedrun",
      "speedrun glitch showcase",
      "how speedrunners break games",
      "fastest completion record"
    ]
  },
  {
    id: "reviews",
    name: "REVIEWS",
    tagline: "News, reviews and essays",
    queries: [
      "video game review",
      "video game essay",
      "gaming news roundup",
      "why this game works",
      "game design analysis",
      "indie game review",
      "game retrospective essay",
      "video game criticism",
      "hidden mechanics explained games",
      "what makes a good game"
    ]
  },
  {
    id: "devs",
    name: "DEVS",
    tagline: "How games get made",
    queries: [
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
    ]
  }
];

export const DEFAULT_MAX_MINUTES = 15;
export const MAX_MINUTES_OPTIONS = [5, 10, 15, 20, 30];
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h -- search.list costs 100 quota units
