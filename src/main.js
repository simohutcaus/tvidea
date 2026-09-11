// src/main.js
// Wires config/storage/api/queue/player together behind the ui.js DOM layer.

import { FEED_QUERIES, DEFAULT_MAX_MINUTES, MAX_MINUTES_OPTIONS } from "./config.js";
import * as storage from "./storage.js";
import { Queue } from "./queue.js";
import { TvPlayer } from "./player.js";
import * as ui from "./ui.js";

const MAX_CONSECUTIVE_FAILURES = 5;

const state = {
  screen: "setup", // "setup" | "standby" | "tv"
  maxMinutes: DEFAULT_MAX_MINUTES,
  volume: 70,
  muted: false,
  consecutiveFailures: 0,
  currentVideo: null,
};

const queue = new Queue(FEED_QUERIES);
let player = null;

function presentApiError(err) {
  const kind = err && err.kind;
  const message = (err && err.message) || "Something went wrong fetching videos.";

  if (kind === "no-key" || kind === "bad-key") {
    ui.showError(message, {
      actionLabel: "Fix key",
      onAction: () => {
        ui.hideError();
        ui.focusSettingsApiKeyField();
      },
    });
  } else if (kind === "quota") {
    ui.showError(message, {
      submessage: "The free daily quota resets at midnight Pacific time. Cached results still play.",
    });
  } else if (kind === "network") {
    ui.showError("Could not reach YouTube. Check your connection.");
  } else {
    ui.showError(message);
  }
}

async function playNext() {
  if (state.screen !== "tv" || !player) return;

  ui.setTuning(true);
  try {
    const video = await queue.next(state.maxMinutes);
    ui.setTuning(false);
    state.consecutiveFailures = 0;
    state.currentVideo = video;
    player.play(video.id);
    ui.updateNowPlaying(video);
    ui.pulseLowerThird();
    ui.setPlayPauseIcon(true);
    queue.prefetch(state.maxMinutes);
  } catch (err) {
    ui.setTuning(false);
    presentApiError(err);
  }
}

function handlePlaybackFailure(code) {
  // A blocked iframe_api never recovers by skipping, so don't burn the
  // failure budget on it -- say what's actually wrong.
  if (code === "api-unavailable") {
    ui.setTuning(false);
    ui.showError("Could not load the YouTube player.", {
      submessage: "A content blocker or network policy is likely blocking youtube.com. Allow it and reload.",
    });
    return;
  }
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    ui.showError("Several videos in a row failed to play.", {
      submessage: "Press Next to keep going.",
    });
    return;
  }
  playNext().catch(() => {});
}

// ---- Controls ------------------------------------------------------------

function togglePlayPause() {
  if (!player) return;
  if (player.isPlaying()) {
    player.pause();
    ui.setPlayPauseIcon(false);
  } else {
    player.resume();
    ui.setPlayPauseIcon(true);
  }
}

function toggleMute() {
  state.muted = !state.muted;
  storage.setMuted(state.muted);
  if (player) {
    if (state.muted) player.mute();
    else player.unmute();
  }
  ui.setMuteIcon(state.muted);
}

function setVolume(v) {
  const clamped = Math.max(0, Math.min(100, v));
  state.volume = clamped;
  storage.setVolume(clamped);
  if (player) player.setVolume(clamped);
  ui.setVolumeSlider(clamped);
  if (clamped > 0 && state.muted) {
    state.muted = false;
    storage.setMuted(false);
    if (player) player.unmute();
    ui.setMuteIcon(false);
  }
}

function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) {
      const target = ui.elements.tvScreen;
      if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  } catch {
    // Fullscreen isn't available in every context (e.g. some embedded
    // views) -- fail silently rather than surface an error toast for it.
  }
}

function wireControls() {
  ui.elements.btnPlayPause.addEventListener("click", togglePlayPause);
  ui.elements.btnNext.addEventListener("click", () => playNext());
  ui.elements.btnMute.addEventListener("click", toggleMute);
  ui.elements.volumeSlider.addEventListener("input", (e) => setVolume(Number(e.target.value)));
  ui.elements.btnFullscreen.addEventListener("click", toggleFullscreen);
  ui.elements.btnSettings.addEventListener("click", ui.openSettings);
  ui.elements.standbySettingsBtn.addEventListener("click", ui.openSettings);
  ui.elements.errorDismiss.addEventListener("click", ui.hideError);
}

function wireSettings() {
  ui.renderMaxMinutesOptions(MAX_MINUTES_OPTIONS, state.maxMinutes, (n) => {
    state.maxMinutes = n;
    storage.setMaxMinutes(n);
    ui.setActiveMaxMinutes(n);
    ui.elements.standbyMaxMinutes.textContent = String(n);
    // Takes effect from the next video: drop buffered picks so the next
    // next() call refetches under the new cap.
    queue.reset();
  });

  ui.elements.settingsClose.addEventListener("click", ui.closeSettings);
  ui.elements.settingsBackdrop.addEventListener("click", ui.closeSettings);

  ui.elements.settingsReplaceKey.addEventListener("click", () => {
    const val = ui.elements.settingsApiKeyInput.value.trim();
    if (!val) return;
    storage.setApiKey(val);
    ui.elements.settingsApiKeyInput.value = "";
    ui.hideError();
    state.consecutiveFailures = 0;
    // The old key is usually being replaced *because* playback failed --
    // retry straight away instead of making the user press Next.
    if (state.screen === "tv" && !state.currentVideo) playNext().catch(() => {});
  });

  ui.elements.settingsClearKey.addEventListener("click", () => {
    storage.clearApiKey();
    ui.closeSettings();
    ui.hideError();
    if (player) {
      player.destroy();
      player = null;
    }
    queue.reset();
    state.screen = "setup";
    ui.showScreen("setup");
  });
}

function wireKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (ui.isTypingTarget(e.target)) return;

    if (e.key === "Escape") {
      if (ui.isSettingsOpen()) ui.closeSettings();
      return;
    }

    if (state.screen !== "tv") return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        togglePlayPause();
        break;
      case "n":
      case "N":
      case "ArrowRight":
        e.preventDefault();
        playNext();
        break;
      case "ArrowUp":
        e.preventDefault();
        setVolume(state.volume + 5);
        break;
      case "ArrowDown":
        e.preventDefault();
        setVolume(state.volume - 5);
        break;
      case "m":
      case "M":
        toggleMute();
        break;
      case "f":
      case "F":
        toggleFullscreen();
        break;
      case "s":
      case "S":
        ui.openSettings();
        break;
      case "?":
        ui.openSettings();
        break;
      default:
        break;
    }
  });
}

// ---- Screen transitions ---------------------------------------------------

function goToStandby() {
  state.screen = "standby";
  ui.showScreen("standby");
}

async function startFeed() {
  state.screen = "tv";
  ui.showScreen("tv");
  state.consecutiveFailures = 0;

  if (!player) {
    player = new TvPlayer("player", {
      onReady: () => {
        player.setVolume(state.volume);
        if (state.muted) player.mute();
      },
      onEnded: () => playNext(),
      onError: (code) => handlePlaybackFailure(code),
      onStateChange: (ytState) => {
        // 1 = PLAYING, 2 = PAUSED (YT.PlayerState)
        if (ytState === 1) ui.setPlayPauseIcon(true);
        if (ytState === 2) ui.setPlayPauseIcon(false);
      },
    });
  }

  await playNext();
}

function init() {
  ui.cacheElements();

  state.maxMinutes = storage.getMaxMinutes();
  state.volume = storage.getVolume();
  state.muted = storage.getMuted();

  ui.elements.standbyMaxMinutes.textContent = String(state.maxMinutes);
  ui.setVolumeSlider(state.volume);
  ui.setMuteIcon(state.muted);
  ui.initIdleFade();

  wireControls();
  wireSettings();
  wireKeyboard();

  ui.elements.setupForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const val = ui.elements.setupApiKeyInput.value.trim();
    if (!val) return;
    storage.setApiKey(val);
    ui.elements.setupError.hidden = true;
    goToStandby();
  });

  ui.elements.powerButton.addEventListener("click", () => {
    startFeed().catch(() => {
      ui.setTuning(false);
    });
  });

  if (storage.getApiKey()) {
    goToStandby();
  } else {
    state.screen = "setup";
    ui.showScreen("setup");
  }
}

init();
