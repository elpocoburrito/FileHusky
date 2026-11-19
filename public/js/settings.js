/* ─── Reactive settings store, persisted to localStorage ─────────────────── */

const SettingsStore = (function () {
  const KEY = 'srvfiles-settings';
  const DEFAULTS = {
    // Appearance
    theme: 'dark',               // 'dark' | 'light'
    tvMode: false,               // remote/controller navigation (TV icon in the header)
    // Files & folders
    hideNonVideos: false,        // only show videos + folders while browsing
    viewMode: 'list',            // 'list' | 'gallery' | 'gallery-lg'
    sortOrder: 'name-asc',       // name-asc | name-desc | size-asc | size-desc | date-desc | date-asc
    // Video playback
    autoplay: true,              // start playing when a video is opened
    resumePlayback: true,        // resume where you left off
    autoNext: true,              // play next video in folder when one ends
    showTranscodeInfo: true,     // show buffering / transcode progress
    videoResolution: '720',      // '480' | '720' | '1080' | 'orig'
    videoQuality: 'medium',      // 'low' | 'medium' | 'high' (encoder quality)
    encodeSpeed: 'fast',         // 'fast' | 'balanced' | 'best' (compression efficiency)
    videoCodec: 'auto',          // 'auto' | 'h264' | 'hevc'
    // Browsing
    rememberPath: true,          // reopen the last visited folder
  };

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) {}
  // 'grid' (icon cards) was replaced by the small gallery view
  if (saved.viewMode === 'grid') saved.viewMode = 'gallery';

  const settings = Vue.reactive(Object.assign({}, DEFAULTS, saved));

  const store = {
    settings,
    defaults: DEFAULTS,
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch (_) {}
    },
    reset() {
      Object.assign(settings, DEFAULTS);
      store.save();
    },
  };

  // Persist automatically on any change
  Vue.watch(settings, () => store.save());

  return store;
})();
