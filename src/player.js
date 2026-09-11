// src/player.js
// Thin wrapper around the YouTube IFrame Player API.

let apiPromise = null;

const API_LOAD_TIMEOUT_MS = 15000;

// Resolves once window.YT.Player exists. Injects the iframe_api script tag
// exactly once even if called multiple times, and chains onto any
// onYouTubeIframeAPIReady callback that was already set.
export function loadPlayerApi() {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    // Content blockers and strict network policies silently drop this script.
    // Without a deadline the app would sit on a black screen forever.
    const deadline = setTimeout(() => {
      reject(new Error("api-unavailable"));
    }, API_LOAD_TIMEOUT_MS);
    const done = (yt) => {
      clearTimeout(deadline);
      resolve(yt);
    };
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") {
        try {
          previous();
        } catch {
          // ignore third-party callback errors
        }
      }
      done(window.YT);
    };
    const already = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!already) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
  return apiPromise;
}

// Fatal embed error codes: 2=invalid param, 5=HTML5 error, 100=not found,
// 101/150=embedding disallowed by the video owner. A blocked embed must
// never stall the feed, so all of these trigger onError -> skip.
const FATAL_ERROR_CODES = new Set([2, 5, 100, 101, 150]);
const WATCHDOG_MS = 12000;

export class TvPlayer {
  constructor(elementId, { onEnded, onError, onReady, onStateChange } = {}) {
    this.elementId = elementId;
    this._onEnded = onEnded || (() => {});
    this._onError = onError || (() => {});
    this._onReady = onReady || (() => {});
    this._onStateChange = onStateChange || (() => {});
    this._player = null;
    this._ready = false;
    this._watchdogTimer = null;
    this._pendingVideoId = null;
    this._destroyed = false;

    this._init();
  }

  async _init() {
    let YT;
    try {
      YT = await loadPlayerApi();
    } catch {
      if (!this._destroyed) this._onError("api-unavailable");
      return;
    }
    if (this._destroyed) return;

    // Autoplay-with-sound is blocked by browsers without a user gesture,
    // which is why the app only ever calls play() after the standby
    // screen's "power on" click.
    const playerVars = {
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
      iv_load_policy: 3,
      fs: 0,
    };

    // origin is a playerVar, not a top-level option -- set anywhere else it
    // is silently ignored. Only valid over http/https; under file:// it would
    // break the postMessage handshake, so omit it there.
    const protocol = window.location.protocol;
    if (protocol === "http:" || protocol === "https:") {
      playerVars.origin = window.location.origin;
    }

    const opts = {
      host: "https://www.youtube.com",
      playerVars,
      events: {
        onReady: () => {
          this._ready = true;
          this._onReady();
          if (this._pendingVideoId) {
            const id = this._pendingVideoId;
            this._pendingVideoId = null;
            this.play(id);
          }
        },
        onStateChange: (e) => this._handleStateChange(e),
        onError: (e) => this._handleError(e),
      },
    };

    this._player = new YT.Player(this.elementId, opts);
  }

  _handleStateChange(e) {
    const YT = window.YT;
    if (YT && e.data === YT.PlayerState.PLAYING) {
      this._clearWatchdog();
    }
    if (YT && e.data === YT.PlayerState.ENDED) {
      this._onEnded();
    }
    this._onStateChange(e.data);
  }

  _handleError(e) {
    this._clearWatchdog();
    if (FATAL_ERROR_CODES.has(e.data)) {
      this._onError(e.data);
    }
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // If a video is loaded but playback never reaches PLAYING within 12s
  // (region lock, silent failure, slow network), treat it as an error so
  // the feed skips instead of sitting frozen.
  _armWatchdog() {
    this._clearWatchdog();
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      this._onError("watchdog-timeout");
    }, WATCHDOG_MS);
  }

  play(videoId) {
    if (!this._ready || !this._player || typeof this._player.loadVideoById !== "function") {
      this._pendingVideoId = videoId;
      return;
    }
    this._player.loadVideoById(videoId);
    this._armWatchdog();
  }

  pause() {
    if (this._ready && this._player.pauseVideo) this._player.pauseVideo();
  }

  resume() {
    if (this._ready && this._player.playVideo) this._player.playVideo();
  }

  isPlaying() {
    if (!this._ready || !window.YT || !this._player.getPlayerState) return false;
    return this._player.getPlayerState() === window.YT.PlayerState.PLAYING;
  }

  setVolume(v) {
    if (this._ready && this._player.setVolume) {
      this._player.setVolume(Math.max(0, Math.min(100, v)));
    }
  }

  mute() {
    if (this._ready && this._player.mute) this._player.mute();
  }

  unmute() {
    if (this._ready && this._player.unMute) this._player.unMute();
  }

  getDuration() {
    return this._ready && this._player.getDuration ? this._player.getDuration() : 0;
  }

  getCurrentTime() {
    return this._ready && this._player.getCurrentTime ? this._player.getCurrentTime() : 0;
  }

  seekTo(seconds) {
    if (this._ready && this._player.seekTo) this._player.seekTo(seconds, true);
  }

  getLoadedFraction() {
    return this._ready && this._player.getVideoLoadedFraction ? this._player.getVideoLoadedFraction() : 0;
  }

  destroy() {
    this._destroyed = true;
    this._clearWatchdog();
    if (this._player && this._player.destroy) {
      try {
        this._player.destroy();
      } catch {
        // ignore teardown errors
      }
    }
    this._player = null;
    this._ready = false;
  }
}
