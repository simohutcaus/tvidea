// src/ui.js
// DOM plumbing: element lookups, screen switching, overlay rendering and
// small UI behaviours (idle fade, lower-third timing, modal open/close).
// Holds no app state beyond what's needed to drive the DOM -- main.js owns
// the actual playback state and calls into here to reflect it.

const el = {};

function q(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`ui.js: expected #${id} in index.html`);
  return node;
}

export function cacheElements() {
  el.setupScreen = q("setup-screen");
  el.standbyScreen = q("standby-screen");
  el.tvScreen = q("tv-screen");

  el.setupForm = q("setup-form");
  el.setupApiKeyInput = q("setup-api-key");
  el.setupError = q("setup-error");

  el.standbyMaxMinutes = q("standby-max-minutes");
  el.powerButton = q("power-button");
  el.standbySettingsBtn = q("standby-settings");

  el.player = q("player");
  el.tuningIndicator = q("tuning-indicator");
  el.chrome = q("chrome");

  el.nowPlaying = document.querySelector("#chrome .now-playing");
  el.npTitle = q("np-title");
  el.npMeta = q("np-meta");

  el.btnPlayPause = q("btn-play-pause");
  el.btnNext = q("btn-next");
  el.btnMute = q("btn-mute");
  el.volumeSlider = q("volume-slider");
  el.timeReadout = q("time-readout");
  el.btnFullscreen = q("btn-fullscreen");
  el.btnSettings = q("btn-settings");

  el.progressBar = q("progress-bar");
  el.progressBuffered = q("progress-buffered");
  el.progressPlayed = q("progress-played");

  el.errorToast = q("error-toast");
  el.errorMessage = q("error-message");
  el.errorSubmessage = q("error-submessage");
  el.errorActionButton = q("error-action-button");
  el.errorDismiss = q("error-dismiss");

  el.settingsBackdrop = q("settings-backdrop");
  el.settingsModal = q("settings-modal");
  el.settingsClose = q("settings-close");
  el.maxMinutesGroup = q("max-minutes-group");
  el.settingsApiKeyInput = q("settings-api-key");
  el.settingsReplaceKey = q("settings-replace-key");
  el.settingsClearKey = q("settings-clear-key");

  return el;
}

export const elements = el;

// ---- Screens ------------------------------------------------------------

export function showScreen(name) {
  el.setupScreen.hidden = name !== "setup";
  el.standbyScreen.hidden = name !== "standby";
  el.tvScreen.hidden = name !== "tv";
}

// ---- Now playing / lower third -------------------------------------------

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

// Compact subscriber counts: 1.4M, 812K, 4.2K -- one decimal place, dropped
// when it would be ".0" (2M, not 2.0M). Plain numbers stay plain below 1000.
function formatSubscribers(n) {
  const abs = Math.abs(n);
  const trim = (v) => {
    const s = v.toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}

export function updateNowPlaying(video) {
  el.npTitle.textContent = video.title;
  const parts = [];
  if (video.channelTitle) parts.push(video.channelTitle);
  if (typeof video.subscribers === "number") {
    parts.push(`${formatSubscribers(video.subscribers)} subscribers`);
  }
  parts.push(formatDuration(video.durationSeconds));
  el.npMeta.textContent = parts.join(" · ");
}

let lowerThirdTimer = null;
const LOWER_THIRD_MS = 6000;

export function pulseLowerThird() {
  el.nowPlaying.classList.remove("hidden-card");
  if (lowerThirdTimer) clearTimeout(lowerThirdTimer);
  lowerThirdTimer = setTimeout(() => {
    el.nowPlaying.classList.add("hidden-card");
  }, LOWER_THIRD_MS);
}

// ---- Idle fade --------------------------------------------------------

let idleTimer = null;
const IDLE_MS = 3000;

export function initIdleFade() {
  const wake = () => {
    el.chrome.classList.remove("idle");
    el.tvScreen.classList.remove("idle");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      el.chrome.classList.add("idle");
      el.tvScreen.classList.add("idle");
    }, IDLE_MS);
    pulseLowerThird();
  };
  window.addEventListener("mousemove", wake, { passive: true });
  window.addEventListener("keydown", wake);
  wake();
}

// ---- Tuning indicator ---------------------------------------------------

export function setTuning(isTuning) {
  el.tuningIndicator.hidden = !isTuning;
}

// ---- Play/pause + mute icons -------------------------------------------

export function setPlayPauseIcon(isPlaying) {
  el.btnPlayPause.querySelector(".icon-play").hidden = isPlaying;
  el.btnPlayPause.querySelector(".icon-pause").hidden = !isPlaying;
  el.btnPlayPause.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

export function setMuteIcon(isMuted) {
  el.btnMute.querySelector(".icon-muted").hidden = !isMuted;
  el.btnMute.querySelector(".icon-unmuted").hidden = isMuted;
  el.btnMute.setAttribute("aria-label", isMuted ? "Unmute" : "Mute");
}

export function setVolumeSlider(v) {
  el.volumeSlider.value = String(v);
}

// ---- Progress bar ---------------------------------------------------------

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

export function setProgress(currentSeconds, durationSeconds, loadedFraction) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    el.progressPlayed.style.width = "0%";
    el.progressBuffered.style.width = "0%";
    el.timeReadout.textContent = "0:00 / 0:00";
    el.progressBar.setAttribute("aria-valuenow", "0");
    el.progressBar.setAttribute("aria-valuetext", "0:00 of 0:00");
    return;
  }

  const playedPct = clamp01(currentSeconds / durationSeconds) * 100;
  const bufferedPct = clamp01(loadedFraction || 0) * 100;

  el.progressPlayed.style.width = `${playedPct}%`;
  el.progressBuffered.style.width = `${bufferedPct}%`;
  el.timeReadout.textContent = `${formatDuration(currentSeconds)} / ${formatDuration(durationSeconds)}`;
  el.progressBar.setAttribute("aria-valuenow", String(Math.round(playedPct)));
  el.progressBar.setAttribute(
    "aria-valuetext",
    `${formatDuration(currentSeconds)} of ${formatDuration(durationSeconds)}`
  );
}

export function resetProgress() {
  setProgress(0, 0, 0);
}

export function onSeek(handler) {
  el.progressBar.addEventListener("click", (e) => {
    const rect = el.progressBar.getBoundingClientRect();
    const fraction = clamp01((e.clientX - rect.left) / rect.width);
    handler(fraction);
  });

  el.progressBar.addEventListener("keydown", (e) => {
    let fraction = null;
    const current = Number(el.progressBar.getAttribute("aria-valuenow")) / 100;
    switch (e.key) {
      case "ArrowLeft":
        fraction = clamp01(current - 0.05);
        break;
      case "ArrowRight":
        fraction = clamp01(current + 0.05);
        break;
      case "Home":
        fraction = 0;
        break;
      case "End":
        fraction = 0.99;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    handler(fraction);
  });
}

// ---- Error toast --------------------------------------------------------

export function showError(message, { submessage = "", actionLabel = "", onAction = null } = {}) {
  el.errorMessage.textContent = message;
  if (submessage) {
    el.errorSubmessage.textContent = submessage;
    el.errorSubmessage.hidden = false;
  } else {
    el.errorSubmessage.hidden = true;
  }
  if (actionLabel && onAction) {
    el.errorActionButton.textContent = actionLabel;
    el.errorActionButton.hidden = false;
    el.errorActionButton.onclick = onAction;
  } else {
    el.errorActionButton.hidden = true;
    el.errorActionButton.onclick = null;
  }
  el.errorToast.hidden = false;
}

export function hideError() {
  el.errorToast.hidden = true;
}

// ---- Settings modal -------------------------------------------------------

export function renderMaxMinutesOptions(options, current, onSelect) {
  el.maxMinutesGroup.innerHTML = "";
  for (const n of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = `${n}m`;
    btn.className = n === current ? "active" : "";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", n === current ? "true" : "false");
    btn.addEventListener("click", () => onSelect(n));
    el.maxMinutesGroup.appendChild(btn);
  }
}

export function setActiveMaxMinutes(n) {
  const buttons = el.maxMinutesGroup.querySelectorAll("button");
  buttons.forEach((btn) => {
    const isActive = btn.textContent === `${n}m`;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-checked", isActive ? "true" : "false");
  });
}

export function isSettingsOpen() {
  return !el.settingsModal.hidden;
}

export function openSettings() {
  el.settingsModal.hidden = false;
  el.settingsBackdrop.hidden = false;
}

export function closeSettings() {
  el.settingsModal.hidden = true;
  el.settingsBackdrop.hidden = true;
}

export function focusSettingsApiKeyField() {
  openSettings();
  el.settingsApiKeyInput.focus();
}

// ---- Keyboard helpers -----------------------------------------------------

export function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
