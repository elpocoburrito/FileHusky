/* ─── App root: registration, hash router, theme ──────────────────────────── */

/* global Vue, UiIcon, SettingsStore, TvMode, FileManager, HomePage, VideoPlayer, SettingsPanel, ToggleSwitch, CastPanel */

(function () {
  'use strict';

  // ── Theme handling ────────────────────────────────────────────────────────
  Vue.watchEffect(() => {
    const theme = SettingsStore.settings.theme;
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#ffffff' : '#121417';
  });

  // ── Tiny hash router ──────────────────────────────────────────────────────
  // #/home              → { name:'home' }
  // #/browse?path=/media/movies   → { name:'browse', path:'/media/movies' }
  // #/video?path=...&name=...&folder=... → { name:'video', ... }
  function parseHash() {
    const h = location.hash.replace(/^#/, '') || '/home';
    const qIdx = h.indexOf('?');
    const route = qIdx === -1 ? h : h.slice(0, qIdx);
    const params = new URLSearchParams(qIdx === -1 ? '' : h.slice(qIdx + 1));

    if (route === '/video' && params.get('path')) {
      return {
        name: 'video',
        path: params.get('path'),
        fileName: params.get('name') || '',
        folder: params.get('folder') || '',
      };
    }
    if (route === '/home' || route === '/') return { name: 'home' };
    return { name: 'browse', path: params.get('path') || null };
  }

  // ── Router plugin: this.$router.push/replace + this.$route ────────────────
  const router = {
    current: Vue.reactive(parseHash()),
    push(to) { applyRoute(to, false); },
    replace(to) { applyRoute(to, true); },
  };

  function toHash(to) {
    if (to.name === 'home') return '#/home';
    if (to.name === 'video') {
      const p = new URLSearchParams();
      p.set('path', to.path);
      if (to.fileName) p.set('name', to.fileName);
      if (to.folder) p.set('folder', to.folder);
      return '#/video?' + p.toString();
    }
    // browse
    if (!to.path) return '#/browse';
    return '#/browse?path=' + encodeURIComponent(to.path);
  }

  function applyRoute(to, replace) {
    const hash = toHash(to);
    if (location.hash === hash) {
      Object.assign(router.current, parseHash());
      return;
    }
    if (replace) {
      history.replaceState(null, '', hash);
      Object.assign(router.current, parseHash());
    } else {
      location.hash = hash; // triggers hashchange
    }
  }

  window.addEventListener('hashchange', () => {
    Object.assign(router.current, parseHash());
    window.scrollTo(0, 0);
  });

  const RouterPlugin = {
    install(app) {
      app.config.globalProperties.$router = router;
      app.config.globalProperties.$route = router.current;
      // Make the current route reactive in templates via a computed alias
      app.mixin({
        computed: {
          $routeReactive() { return router.current; },
        },
      });
    },
  };

  // ── App ───────────────────────────────────────────────────────────────────
  const app = Vue.createApp({
    data() {
      return {
        settingsOpen: false,
      };
    },
    computed: {
      route() { return router.current; },
    },
    watch: {
      // Close settings sheet whenever the view changes
      'route.name'() { this.settingsOpen = false; },
      'route.path'() { this.settingsOpen = false; },
    },
  });

  app.use(RouterPlugin);
  app.component('ui-icon', UiIcon);
  app.component('toggle-switch', ToggleSwitch);
  app.component('tv-toggle', TvMode.TvToggle);
  app.component('file-manager', FileManager);
  app.component('home-page', HomePage);
  app.component('cast-panel', CastPanel);
  app.component('video-player', VideoPlayer);
  app.component('settings-panel', SettingsPanel);

  app.mount('#app');

  // TV mode restores itself from settings once the DOM exists
  TvMode.init();
})();
