# tvidea

A TV channel for gaming videos. Point it at a browser tab and leave it running
in the background: it endlessly autoplays gaming videos capped at a length
you choose (30 minutes by default; 5/10/15/20/30 available), across four curated
channels, with a minimal on-screen TV UI so you can glance over and flick to
something interesting.

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
(`videos.list`) costs 1 unit. To stay well inside that budget, tvidea caches
every search and detail response in `localStorage` for 6 hours — repeat
browsing (switching back to a channel, reloading the page) reuses cached
results instead of spending quota again. If you do exceed the quota, it
resets at midnight Pacific time; cached results keep working in the
meantime.

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
| `N` | Next video |
| `←` / `→` | Previous / next channel |
| `↑` / `↓` | Volume up / down (±5) |
| `M` | Mute |
| `F` | Fullscreen |
| `S` | Settings |
| `?` | Shortcuts help (opens Settings) |
| `Escape` | Close the open dialog |

Shortcuts are ignored while a text field is focused.

## How it works

- **`src/config.js`** — the four channels (RETRO, SPEEDRUN, REVIEWS, DEVS),
  each with a pool of search queries, plus the tunables (default/allowed max
  lengths, cache TTL).
- **`src/storage.js`** — a small `localStorage` wrapper (API key, volume,
  mute, last channel, max length, and the response cache), all
  try/catch-guarded so a browser with storage disabled just falls back to
  in-memory defaults instead of crashing.
- **`src/api.js`** — talks to the YouTube Data API: a `search.list` call per
  query (randomized `order`, cached), followed by a `videos.list` call to
  fetch exact durations and confirm the video is public and embeddable. Only
  videos that fit your max-length cap make it through.

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

  If a channel's mix feels wrong after living with it, the query pools in
  `src/config.js` are plain strings — that's the first place to tune.
- **`src/queue.js`** — a per-channel playlist buffer. It refills in the
  background as it gets low, cycles through the channel's query pool so
  every query gets used before repeating, and tracks which videos have
  already played this session so nothing repeats (until the pool runs dry,
  at which point it clears its memory rather than getting stuck).
- **`src/player.js`** — wraps the YouTube IFrame Player API: loads the
  player script once, maps playback errors (blocked embeds, region locks)
  straight to "skip this video", and watches for videos that silently fail
  to start so the channel never just sits there frozen.
- **`src/ui.js`** / **`src/main.js`** — the three screens (API key setup,
  standby "power on", and the full-screen TV view with its lower-third
  title card, channel bar, and control cluster), and the glue that ties
  queue → player → UI together, including keyboard shortcuts and the
  auto-skip-on-failure logic.

Autoplay with sound is blocked by browsers without a user gesture, which is
why there's a standby "power on" screen between entering your key and the
video actually starting.
