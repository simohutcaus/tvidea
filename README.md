# tvidea

A TV channel for gaming videos. Point it at a browser tab and leave it running
in the background: it endlessly autoplays gaming videos capped at a length
you choose (30 minutes by default; 5/10/15/20/30 available), drawn from one
continuous feed, with a minimal on-screen TV UI so you can glance over and
flick to something interesting.

It's a pure static site — no backend, no build step, no framework, no npm.
Plain HTML, CSS and vanilla JS (ES modules) that any static file host can
serve as-is.

## Getting a YouTube Data API v3 key

tvidea needs your own free YouTube Data API v3 key to search for and look up
videos. It is stored only in your browser's `localStorage` and is only ever
sent to `googleapis.com` — never logged, never sent anywhere else.

1. Open [console.cloud.google.com → YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
   and create (or select) a project.
2. Click **Enable** to turn the YouTube Data API v3 on for that project.
3. Open **Credentials** in the sidebar, then **Create Credentials → API key**.
4. Copy the key and paste it into tvidea's setup screen.
5. **Restrict the key.** In the console, open the key and set *Application
   restrictions → Websites*, listing the origins you'll actually use (e.g.
   `http://localhost:8000` and your GitHub Pages domain), and *API
   restrictions → YouTube Data API v3*. The key lives in your browser, so
   referrer restriction is what stops it being reused elsewhere.

**Quota note:** the free tier gives you 10,000 units/day. A single search
(`search.list`) costs 100 units; the follow-up detail lookup
(`videos.list`) costs 1 unit, and the subscriber-count lookup
(`channels.list`, see "How it works" below) costs another 1 unit. To stay
well inside that budget, tvidea caches every search, detail and
channel-statistics response in `localStorage` for 6 hours — repeat browsing
(reloading the page) reuses cached results instead of spending quota again.
If you do exceed the quota, it resets at midnight Pacific time; cached
results keep working in the meantime.

## Running locally

No install step — just serve the folder:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000> in a browser.

(Any static file server works — this is just the simplest one.)

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. In the repo settings, open **Pages** and set the source to the branch
   you pushed (root directory).
3. GitHub Pages will serve `index.html` directly. The included `.nojekyll`
   file stops GitHub's Jekyll processing from mangling the `src/` directory.

Your API key never leaves the browser it's entered in — there's nothing to
configure as a secret on the GitHub side.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `N` / `→` | Next video |
| `↑` / `↓` | Volume up / down (±5) |
| `M` | Mute |
| `F` | Fullscreen |
| `S` | Settings |
| `?` | Shortcuts help (opens Settings) |
| `Escape` | Close the open dialog |

Shortcuts are ignored while a text field is focused.

## How it works

- **`src/config.js`** — `FEED_QUERIES`, a single flat pool of search queries
  covering retro, speedrun, review/essay and dev-focused gaming content, plus
  the tunables (default/allowed max lengths, cache TTL, and the quality
  weighting knobs described below).
- **`src/storage.js`** — a small `localStorage` wrapper (API key, volume,
  mute, max length, and the response cache), all try/catch-guarded so a
  browser with storage disabled just falls back to in-memory defaults instead
  of crashing.
- **`src/api.js`** — talks to the YouTube Data API: a `search.list` call per
  query (randomized `order`, cached), followed by a `videos.list` call to
  fetch exact durations, view counts, and confirm the video is public and
  embeddable. Only videos that fit your max-length cap make it through.

  Two filters exist purely for content quality, both arrived at by running
  the real API and reading what came back:

  - **Gaming category only** (`videoCategoryId=20`). Without it, searches
    drift badly — "gaming highlights clips" returns football highlights,
    "video game review" returns gaming-drama commentary, "game development"
    returns generic coding tutorials. It costs almost no yield.
  - **A three-minute floor, and the "short" duration bucket is never
    requested.** Sub-four-minute gaming results are dominated by Shorts-style
    filler, and a new video every 70 seconds is churn, not background noise.

  Above a 20-minute cap the search mixes YouTube's "medium" (4-20 min) and
  "long" (20+ min) buckets roughly 2:1 rather than asking for "any". Measured
  live, "any" discards ~60% of what it fetches (hour-long playthroughs), while
  "medium" alone never reaches past 20 minutes and leaves the extra headroom
  unused. The mix lands at ~64% usable with a real spread across the range.

  If the feed's mix feels wrong after living with it, `FEED_QUERIES` in
  `src/config.js` is a plain array of strings — that's the first place to
  tune.

  ### Quality weighting

  Subscriber count is used to bias which videos surface, as a soft weight —
  never a hard gate, and never a straight ranking. That came from actually
  looking at the results: sampled against the live API over 132 videos from
  109 channels, the subscriber distribution turned out almost perfectly flat
  across bands (roughly equal numbers under 1k, 1k-10k, 10k-100k, 100k-1M and
  over 1M subscribers). Reading through that sample surfaced two problems at
  opposite ends:

  - **The bottom is genuine junk.** Sub-1,000-subscriber channels included
    0-8 subscriber accounts and 8-85 view uploads that read as student
    coursework, not something worth serving into a background feed.
  - **The very top is also bad, just differently.** The highest-subscriber
    results skewed toward kids' content farms and clickbait — a "Minecraft
    Speedrun" video from a 17.7M-subscriber channel, "Speedrunning Minecraft
    but I enslave villagers" from one with 7.9M. Ranking by raw subscriber
    count would mean the feed converges on a handful of mega-channels like
    these every time.

  So `src/api.js` fetches `statistics` on `videos.list` (free — that endpoint
  costs 1 quota unit no matter how many `part`s you ask for) to get view
  counts, then makes one extra `channels.list` call per 50 unique channel ids
  in a batch to get subscriber counts. That's 1 more quota unit against
  `search.list`'s 100, negligible. A channel that hides its subscriber count
  is treated as unknown, not zero — it's kept, but held to a higher view-count
  bar in exchange for the missing signal.

  Videos under 1,000 subscribers or 1,000 views are dropped outright — that's
  the low floor. Everything that clears it gets a weight from
  `clamp(log10(subscribers), 3, 6) - 2`: 1k subscribers is 1.0, 10k is 2.0,
  100k is 3.0, 1M is 4.0 — and it stops climbing there, so a 17M-subscriber
  channel also weighs 4.0. `src/queue.js` then samples without replacement
  using those weights (Efraimidis-Spirakis: draw `random() ** (1/weight)` per
  video and sort descending) rather than sorting by them — a weight-4 video
  has a better expected position than a weight-1 one, but every video keeps a
  real chance at any slot, so the feed still turns up small channels instead
  of only ever the same big ones.
- **`src/queue.js`** — the feed's playlist buffer. It refills in the
  background as it gets low, cycles through the query pool so every query
  gets used before repeating, weights fresh results by the subscriber signal
  above before adding them, and tracks which videos have already played this
  session so nothing repeats (until the pool runs dry, at which point it
  clears its memory rather than getting stuck).
- **`src/player.js`** — wraps the YouTube IFrame Player API: loads the
  player script once, maps playback errors (blocked embeds, region locks)
  straight to "skip this video", and watches for videos that silently fail
  to start so the feed never just sits there frozen.
- **`src/ui.js`** / **`src/main.js`** — the three screens (API key setup,
  standby "power on", and the full-screen TV view with its lower-third
  title card and control cluster), and the glue that ties queue → player →
  UI together, including keyboard shortcuts and the auto-skip-on-failure
  logic.

Autoplay with sound is blocked by browsers without a user gesture, which is
why there's a standby "power on" screen between entering your key and the
video actually starting.
