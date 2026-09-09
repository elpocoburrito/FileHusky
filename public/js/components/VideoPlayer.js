/* ─── VideoPlayer: dedicated playback page ───────────────────────────────── */

/* global Vue, Utils, SettingsStore, Hls */

const VideoPlayer = {
  name: 'VideoPlayer',
  props: {
    path: { type: String, required: true },
    fileName: { type: String, default: '' },
    folder: { type: String, default: '' },
  },
  emits: ['open-settings'],

  data() {
    return {
      phase: 'loading',        // 'loading' | 'ready' | 'error'
      statusText: 'Preparing…',
      errorMsg: null,
      meta: null,              // metadata from server
      stream: null,            // stream info from server
      cachedSegments: 0,
      totalSegments: 0,
      fullyCached: false,
      upNext: [],              // other videos in the same folder
      resumeSeconds: 0,        // position we will resume from
      hls: null,
      statusTimer: null,
      saveTimer: null,
    };
  },

  computed: {
    s() { return SettingsStore.settings; },

    displayName() {
      return this.fileName || this.path.split(/[\\/]/).pop();
    },

    resolutionText() {
      if (!this.meta || !this.meta.width) return '';
      let t = this.meta.width + '×' + this.meta.height;
      if (this.meta.fps) t += ' · ' + this.meta.fps + ' fps';
      if (this.meta.codec) t += ' · ' + this.meta.codec.toUpperCase();
      return t;
    },

    bufferPercent() {
      if (!this.totalSegments) return 0;
      return Math.round(this.cachedSegments / this.totalSegments * 100);
    },
  },

  watch: {
    // Swapping to another video ("up next") reuses this component — reload
    path() {
      this.start();
      this.loadUpNext();
    },
  },

  async mounted() {
    await this.start();
    if (this.folder) this.loadUpNext();
  },

  beforeUnmount() {
    this.savePosition();
    this.cleanup();
  },

  methods: {
    async start() {
      this.cleanup();
      this.phase = 'loading';
      this.errorMsg = null;
      this.statusText = 'Analyzing video…';
      this.fullyCached = false;

      try {
        // 1. Metadata (duration, resolution) — shown immediately
        this.meta = await Utils.api('/api/video/metadata?path=' + encodeURIComponent(this.path));

        // 2. Start transcode session
        this.statusText = 'Starting transcoder…';
        this.stream = await Utils.api('/api/video/stream/start?path=' + encodeURIComponent(this.path));
        this.totalSegments = this.stream.segments;
        this.cachedSegments = 0;

        // 3. Attach player
        await this.attachPlayer();

        this.phase = 'ready';
        this.statusText = 'Playing';
        this.startStatusPolling();
      } catch (e) {
        this.phase = 'error';
        this.errorMsg = e.message;
      }
    },

    async attachPlayer() {
      const player = this.$refs.video;

      // Restore resume position (per-browser, per-file)
      this.resumeSeconds = 0;
      if (this.s.resumePlayback) {
        const saved = parseFloat(localStorage.getItem('srvfiles-resume:' + this.path) || '0');
        if (saved > 15 && this.meta.duration && saved < this.meta.duration - 30) {
          this.resumeSeconds = saved;
        }
      }

      const onLoaded = () => {
        if (this.resumeSeconds > 0) {
          player.currentTime = this.resumeSeconds;
          this.statusText = 'Resumed at ' + Utils.formatDuration(this.resumeSeconds);
          setTimeout(() => { if (this.statusText.startsWith('Resumed')) this.statusText = 'Playing'; }, 4000);
        }
        if (this.s.autoplay) {
          player.play().catch(() => { /* autoplay blocked */ });
        }
        player.removeEventListener('loadedmetadata', onLoaded);
      };
      player.addEventListener('loadedmetadata', onLoaded);

      if (window.Hls && Hls.isSupported()) {
        this.hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 30,
          maxBufferLength: 40,
          maxMaxBufferLength: 60,
        });
        this.hls.loadSource(this.stream.playlistUrl);
        this.hls.attachMedia(player);
        this.hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            this.phase = 'error';
            this.errorMsg = 'Playback error: ' + (data.details || data.type || 'unknown') +
              '. The transcode session may have expired.';
            this.cleanup();
          }
        });
      } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS (Safari / iOS)
        player.src = this.stream.playlistUrl;
      } else {
        throw new Error('HLS is not supported in this browser. Try Chrome, Edge, or Safari.');
      }

      // Save resume position periodically + on pause
      player.addEventListener('timeupdate', this.onTimeUpdate);
      player.addEventListener('ended', this.onEnded);
    },

    onTimeUpdate() {
      const player = this.$refs.video;
      if (!player) return;
      // Throttle writes to every 3 s
      const now = Date.now();
      if (!this._lastSave || now - this._lastSave > 3000) {
        this._lastSave = now;
        localStorage.setItem('srvfiles-resume:' + this.path, String(player.currentTime));
      }
    },

    savePosition() {
      const player = this.$refs.video;
      if (!player || !player.currentTime) return;
      if (this.meta && this.meta.duration && player.currentTime > this.meta.duration - 15) {
        // Basically finished — clear resume point
        localStorage.removeItem('srvfiles-resume:' + this.path);
      } else {
        localStorage.setItem('srvfiles-resume:' + this.path, String(player.currentTime));
      }
    },

    onEnded() {
      localStorage.removeItem('srvfiles-resume:' + this.path);
      if (this.s.autoNext && this.upNext.length > 0) {
        this.openVideo(this.upNext[0]);
      }
    },

    startStatusPolling() {
      this.stopStatusPolling();
      this.statusTimer = setInterval(() => this.updateStatus(), 2000);
      this.updateStatus();
    },

    stopStatusPolling() {
      if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    },

    async updateStatus() {
      if (!this.stream) return;
      try {
        const st = await Utils.api('/api/video/stream/' + this.stream.streamId + '/status');
        this.cachedSegments = st.cachedSegments;
        this.totalSegments = st.totalSegments;
        if (st.cachedSegments >= st.totalSegments) {
          this.fullyCached = true;
          this.stopStatusPolling();
        }
      } catch (_) {
        // stream probably expired
        this.stopStatusPolling();
      }
    },

    async loadUpNext() {
      try {
        const data = await Utils.api('/api/browse?path=' + encodeURIComponent(this.folder));
        this.upNext = data.contents.filter(
          c => c.isVideo && c.path !== this.path
        );
      } catch (_) { /* folder may be gone; ignore */ }
    },

    openVideo(item) {
      this.savePosition();
      this.$router.push({
        name: 'video',
        path: item.path,
        fileName: item.name,
        folder: this.folder,
      });
    },

    restart() {
      this.start();
    },

    goBack() {
      if (window.history.length > 1) window.history.back();
      else this.$router.replace({ name: 'browse', path: this.folder || Utils.defaultPath() });
    },

    cleanup() {
      this.stopStatusPolling();
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      const player = this.$refs.video;
      if (player) {
        player.removeEventListener('timeupdate', this.onTimeUpdate);
        player.removeEventListener('ended', this.onEnded);
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
    },
  },

  template: `
  <div class="page page-player">

    <!-- ── Sticky header ─────────────────────────────────────────────── -->
    <header class="app-header">
      <div class="header-row">
        <button class="icon-btn" @click="goBack" title="Back to files">
          <ui-icon name="arrowBack"></ui-icon>
        </button>
        <h1 class="header-title">{{ displayName }}</h1>
        <button class="icon-btn" @click="$emit('open-settings')" title="Settings">
          <ui-icon name="settings"></ui-icon>
        </button>
      </div>
    </header>

    <!-- ── Sticky video area ─────────────────────────────────────────── -->
    <div class="video-area">
      <video ref="video" class="video-el" controls playsinline preload="auto"></video>

      <div v-if="phase === 'loading'" class="video-overlay">
        <div class="spinner"></div>
        <p>{{ statusText }}</p>
      </div>

      <div v-if="phase === 'error'" class="video-overlay error">
        <ui-icon name="warning" :size="44"></ui-icon>
        <p>{{ errorMsg }}</p>
        <button class="btn primary" @click="restart">
          <ui-icon name="restart" :size="20"></ui-icon> Restart playback
        </button>
      </div>
    </div>

    <main class="page-body player-body">

      <!-- ── Info card ───────────────────────────────────────────────── -->
      <section class="info-card">
        <div class="info-head">
          <ui-icon name="movie" :size="26" class="info-icon"></ui-icon>
          <div class="info-titles">
            <h2 class="info-name">{{ displayName }}</h2>
            <p class="info-sub">{{ resolutionText }}</p>
          </div>
          <button class="icon-btn" @click="restart" title="Reload video">
            <ui-icon name="refresh"></ui-icon>
          </button>
        </div>

        <!-- Transcode status -->
        <div v-if="s.showTranscodeInfo && stream && !fullyCached" class="buffer-box">
          <div class="buffer-row">
            <span class="buffer-label">Preparing video</span>
            <span class="buffer-num">{{ cachedSegments }}/{{ totalSegments }} segments</span>
          </div>
          <div class="buffer-bar"><div class="buffer-fill" :style="{width: bufferPercent + '%'}"></div></div>
        </div>
        <div v-else-if="s.showTranscodeInfo && stream && fullyCached" class="buffer-done">
          <ui-icon name="check" :size="18"></ui-icon> Fully buffered
        </div>
      </section>

      <!-- ── Up next in folder ───────────────────────────────────────── -->
      <section v-if="upNext.length > 0" class="upnext">
        <h3 class="section-title">Up next in this folder</h3>
        <ul class="file-list">
          <li v-for="item in upNext" :key="item.path">
            <button class="file-row" @click="openVideo(item)">
              <span class="file-icon is-video"><ui-icon name="movie" :size="26"></ui-icon></span>
              <span class="file-text">
                <span class="file-name">{{ item.name }}</span>
                <span class="file-sub">{{ item.sizeFormatted }}</span>
              </span>
              <ui-icon name="play" :size="22" class="file-play"></ui-icon>
            </button>
          </li>
        </ul>
      </section>
    </main>
  </div>
  `,
};
