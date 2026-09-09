/* ─── Reactive settings store, persisted to localStorage ─────────────────── */

const SettingsStore = (function () {
  const KEY = 'srvfiles-settings';
  const DEFAULTS = {
    // Appearance
    theme: 'dark',               // 'dark' | 'light'
    // Files & folders
    hideNonVideos: false,        // only show videos + folders while browsing
    viewMode: 'list',            // 'list' | 'grid'
    sortOrder: 'name-asc',       // name-asc | name-desc | size-asc | size-desc | date-desc | date-asc
    // Video playback
    autoplay: true,              // start playing when a video is opened
    resumePlayback: true,        // resume where you left off
    autoNext: true,              // play next video in folder when one ends
    showTranscodeInfo: true,     // show buffering / transcode progress
    // Browsing
    rememberPath: true,          // reopen the last visited folder
  };

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) {}

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
