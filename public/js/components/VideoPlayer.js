/* ─── VideoPlayer: dedicated playback page ───────────────────────────────── */

/* global Vue, Utils, SettingsStore, Hls */

const VIDEO_EXT_DIRECT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.m4v']);
const DIRECT_VIDEO_CODECS = new Set(['h264', 'vp9', 'av1']);
const DIRECT_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

// HEVC decode capability: MSE (hls.js path) or native HLS (Safari/iOS).
// Probed once per session — decoding hardware does not change mid-session.
let _hevcOk = null;
function hevcSupported() {
  if (_hevcOk !== null) return _hevcOk;
  try {
    // A representative Main@L3.1 profile string; devices able to decode
    // HEVC in MP4 report true (hls.js serves HEVC in fMP4)
    _hevcOk = typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
  } catch (_) {
    _hevcOk = false;
  }
  return _hevcOk;
}

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
      upNext: [],              // other videos in the same folder (for the list)
      folderVideos: [],        // ALL videos of the folder, in order (for prev/next)
      resumeSeconds: 0,        // position we will resume from
      hls: null,
      statusTimer: null,
      saveTimer: null,

      // ── UI-only state (custom control bar) — does not affect playback ──
      isPlaying: false,
      muted: false,
      loopOn: false,
      controlsVisible: true,
      hideTimer: null,
      currentTime: 0,
      bufferedPercent: 0,
      scrubbing: false,
      externalOpen: false,
      copied: false,
      qualityOpen: false,
      pendingSeek: 0,          // restart-at-position (quality change)
      activeCodec: 'h264',     // codec actually in use for this session
    };
  },

  computed: {
    s() { return SettingsStore.settings; },

    // Template needs to disable the HEVC option on unsupported devices
    hevcSupported: () => hevcSupported(),

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

    // ── Navigation within the folder (prev/next) ──
    currentIndex() {
      return this.folderVideos.findIndex(v => v.path === this.path);
    },
    prevVideo() {
      return this.currentIndex > 0 ? this.folderVideos[this.currentIndex - 1] : null;
    },
    nextVideo() {
      const i = this.currentIndex;
      return (i >= 0 && i < this.folderVideos.length - 1) ? this.folderVideos[i + 1] : null;
    },

    // ── Seek bar ──
    seekMax() {
      return (this.meta && this.meta.duration) ? this.meta.duration : 0;
    },
    currentTimePercent() {
      return this.seekMax ? Math.min(100, this.currentTime / this.seekMax * 100) : 0;
    },

    rawUrl() {
      return location.origin + '/api/video/raw?path=' + encodeURIComponent(this.path);
    },
    hlsUrl() {
      return this.stream ? location.origin + this.stream.playlistUrl : '';
    },

    // ── Quality settings (see quality menu / settings panel) ──
    canDirectPlay() {
      if (!this.meta) return false;
      const ext = this.path.slice(this.path.lastIndexOf('.')).toLowerCase();
      return VIDEO_EXT_DIRECT.has(ext) &&
        DIRECT_VIDEO_CODECS.has(this.meta.codec) &&
        DIRECT_AUDIO_CODECS.has(this.meta.audioCodec);
    },

    useDirect() {
      // 'Original' + browser-compatible file → stream the file directly,
      // no transcoding. Falls back to transcode for incompatible files.
      return this.s.videoResolution === 'orig' && this.canDirectPlay;
    },

    activeConfig() {
      if (this.useDirect) return 'Direct play — original quality, no transcoding';
      const res = this.s.videoResolution === 'orig' ? 'original resolution' : this.s.videoResolution + 'p';
      const speed = { fast: 'fastest', balanced: 'balanced', best: 'best' }[this.s.encodeSpeed] || 'fastest';
      const codecName = this.activeCodec === 'hevc' ? 'HEVC' : 'H.264';
      return 'Transcoding · ' + res + ' · ' + this.s.videoQuality + ' quality · ' + speed + ' encoding · ' + codecName;
    },

    // ── Quality menu options ──
    resolutionOptions() {
      return [
        { value: '480', label: '480p · data saver' },
        { value: '720', label: '720p' },
        { value: '1080', label: '1080p' },
        { value: 'orig', label: 'Original' + (this.canDirectPlay ? ' · direct' : '') },
      ];
    },

    qualityOptions() {
      return [
        { value: 'low', label: 'Low · smallest files' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High · sharpest' },
      ];
    },

    speedOptions() {
      return [
        { value: 'fast', label: 'Fastest · uses more data' },
        { value: 'balanced', label: 'Balanced' },
        { value: 'best', label: 'Best compression · most CPU/GPU' },
      ];
    },

    codecOptions() {
      const hevc = hevcSupported();
      return [
        { value: 'auto', label: 'Auto' + (hevc ? ' · HEVC here' : ' · H.264 here') },
        { value: 'h264', label: 'H.264 · max compatibility' },
        { value: 'hevc', label: 'HEVC · ~40% less data' + (hevc ? '' : ' · NOT supported on this device') },
      ];
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
    document.addEventListener('keydown', this.onKey);
    await this.start();
    if (this.folder) this.loadUpNext();
  },

  beforeUnmount() {
    document.removeEventListener('keydown', this.onKey);
    this.clearHideTimer();
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

      // Reset UI-only state
      this.isPlaying = false;
      this.loopOn = false;
      this.currentTime = 0;
      this.bufferedPercent = 0;
      this.scrubbing = false;
      this.controlsVisible = true;

      try {
        // 1. Metadata (duration, resolution) — shown immediately
        this.meta = await Utils.api('/api/video/metadata?path=' + encodeURIComponent(this.path));

        if (this.useDirect) {
          // Direct play: no transcode session needed
          this.stream = null;
          await this.attachPlayer();
          this.phase = 'ready';
          this.statusText = 'Playing';
          return;
        }

        // 2. Start transcode session with current quality settings
        this.statusText = 'Starting transcoder…';
        const requestedCodec = this.s.videoCodec === 'auto'
          ? (hevcSupported() ? 'hevc' : 'h264')
          : this.s.videoCodec;
        this.activeCodec = requestedCodec;
        const params = 'res=' + encodeURIComponent(this.s.videoResolution) +
          '&cq=' + encodeURIComponent(this.s.videoQuality) +
          '&speed=' + encodeURIComponent(this.s.encodeSpeed) +
          '&codec=' + encodeURIComponent(requestedCodec);
        this.stream = await Utils.api('/api/video/stream/start?path=' +
          encodeURIComponent(this.path) + '&' + params);
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

      // Restore resume position (per-browser, per-file), or an explicit
      // restart-at-position after a quality change
      this.resumeSeconds = this.pendingSeek || 0;
      this.pendingSeek = 0;
      if (!this.resumeSeconds && this.s.resumePlayback) {
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

      if (this.useDirect) {
        // Direct play of the original file (browser-compatible sources)
        player.src = this.rawUrl;
      } else if (window.Hls && Hls.isSupported()) {
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

      // ── UI-only listeners (drive the custom control bar) ──
      player.addEventListener('timeupdate', this.onTimeUi);
      player.addEventListener('play', this.onPlayPauseUi);
      player.addEventListener('pause', this.onPlayPauseUi);
      player.addEventListener('volumechange', this.onVolumeUi);
      player.addEventListener('progress', this.onBufferUi);
      this.muted = player.muted;
    },

    /** Apply a quality/speed/resolution change: seamless restart at position */
    changePlayback() {
      const player = this.$refs.video;
      this.pendingSeek = (player && this.phase === 'ready') ? player.currentTime : 0;
      this.start();
    },

    setQuality(key, value) {
      if (this.s[key] === value) return;
      this.s[key] = value;
      this.qualityOpen = false;
      this.changePlayback();
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
      if (this.loopOn) return; // looping is handled natively by the video element
      localStorage.removeItem('srvfiles-resume:' + this.path);
      if (this.s.autoNext && this.nextVideo) {
        this.openVideo(this.nextVideo);
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
        const videos = data.contents.filter(c => c.isVideo);
        this.folderVideos = videos;                              // ordered, for prev/next
        this.upNext = videos.filter(c => c.path !== this.path);  // for the list
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

    goPrev() {
      if (this.prevVideo) this.openVideo(this.prevVideo);
    },

    goNext() {
      if (this.nextVideo) this.openVideo(this.nextVideo);
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
        player.removeEventListener('timeupdate', this.onTimeUi);
        player.removeEventListener('play', this.onPlayPauseUi);
        player.removeEventListener('pause', this.onPlayPauseUi);
        player.removeEventListener('volumechange', this.onVolumeUi);
        player.removeEventListener('progress', this.onBufferUi);
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
    },

    // ═══ UI-only methods (control bar) ═══════════════════════════════════

    fmt(t) {
      return Utils.formatDuration(t);
    },

    onTimeUi() {
      const player = this.$refs.video;
      if (!player || this.scrubbing) return;
      this.currentTime = player.currentTime;
      this.onBufferUi();
    },

    onPlayPauseUi() {
      const player = this.$refs.video;
      if (!player) return;
      this.isPlaying = !player.paused;
      if (player.paused) {
        this.controlsVisible = true;
        this.clearHideTimer();
      } else {
        this.scheduleHide();
      }
    },

    onVolumeUi() {
      const player = this.$refs.video;
      if (!player) return;
      this.muted = player.muted || player.volume === 0;
    },

    onBufferUi() {
      const player = this.$refs.video;
      if (!player || !this.seekMax) return;
      let end = 0;
      for (let i = 0; i < player.buffered.length; i++) {
        if (player.buffered.start(i) <= player.currentTime + 1 && player.buffered.end(i) > end) {
          end = player.buffered.end(i);
        }
      }
      this.bufferedPercent = Math.min(100, end / this.seekMax * 100);
    },

    togglePlay() {
      const player = this.$refs.video;
      if (!player) return;
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    },

    toggleMute() {
      const player = this.$refs.video;
      if (!player) return;
      player.muted = !player.muted;
    },

    toggleLoop() {
      const player = this.$refs.video;
      if (!player) return;
      player.loop = !player.loop;
      this.loopOn = player.loop;
    },

    toggleFullscreen() {
      const area = this.$refs.videoArea;
      const player = this.$refs.video;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if (area && area.requestFullscreen) {
        area.requestFullscreen().catch(() => {});
      } else if (player && player.webkitEnterFullscreen) {
        player.webkitEnterFullscreen(); // iOS Safari: fullscreen for the video element
      }
    },

    seekInput(e) {
      // Preview only — commit on change so dragging feels smooth
      this.scrubbing = true;
      this.currentTime = parseFloat(e.target.value);
    },

    seekCommit(e) {
      const player = this.$refs.video;
      const t = parseFloat(e.target.value);
      this.scrubbing = false;
      this.currentTime = t;
      if (player) player.currentTime = t;
      this.scheduleHide();
    },

    seekStyle() {
      const cur = this.currentTimePercent;
      const buf = Math.max(cur, this.bufferedPercent);
      return {
        background: 'linear-gradient(to right,' +
          ' var(--accent) 0%, var(--accent) ' + cur + '%,' +
          ' rgba(255,255,255,.45) ' + cur + '%, rgba(255,255,255,.45) ' + buf + '%,' +
          ' rgba(255,255,255,.22) ' + buf + '%, rgba(255,255,255,.22) 100%)',
      };
    },

    onVideoClick() {
      this.qualityOpen = false;
      this.controlsVisible = !this.controlsVisible;
      if (this.controlsVisible) this.scheduleHide();
      else this.clearHideTimer();
    },

    showControls() {
      this.controlsVisible = true;
      this.scheduleHide();
    },

    scheduleHide() {
      this.clearHideTimer();
      const player = this.$refs.video;
      if (!player || player.paused) return; // always show controls when paused
      this.hideTimer = setTimeout(() => { this.controlsVisible = false; }, 3000);
    },

    clearHideTimer() {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    },

    onKey(e) {
      if (this.phase !== 'ready' || this.externalOpen) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const player = this.$refs.video;
      if (!player) return;
      switch (e.key) {
        case ' ': e.preventDefault(); this.togglePlay(); break;
        case 'ArrowLeft': player.currentTime = Math.max(0, player.currentTime - 10); break;
        case 'ArrowRight': player.currentTime = player.currentTime + 10; break;
        case 'm': case 'M': this.toggleMute(); break;
        case 'f': case 'F': this.toggleFullscreen(); break;
        case 'l': case 'L': this.toggleLoop(); break;
        case 'n': case 'N': this.goNext(); break;
        case 'p': case 'P': this.goPrev(); break;
        case 'Escape':
          if (this.externalOpen) this.externalOpen = false;
          if (this.qualityOpen) this.qualityOpen = false;
          break;
      }
    },

    async copyLink() {
      try {
        await navigator.clipboard.writeText(this.rawUrl);
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 2000);
      } catch (_) {
        // Fallback for browsers without clipboard permission
        const input = this.$refs.rawInput;
        if (input) { input.select(); document.execCommand('copy'); this.copied = true; setTimeout(() => { this.copied = false; }, 2000); }
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
    <div class="video-area" ref="videoArea">
      <video ref="video" class="video-el" playsinline preload="auto" @click="onVideoClick"></video>

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

      <!-- ── Custom control bar (UI only) ──────────────────────────── -->
      <div v-show="phase === 'ready'" class="vcontrols"
           :class="{ 'vcontrols-hidden': !controlsVisible }" @click.stop>

        <!-- Quality menu popover -->
        <div v-if="qualityOpen" class="vc-quality" @click.stop>
          <div class="vq-group">
            <div class="vq-title">Resolution</div>
            <button v-for="opt in resolutionOptions" :key="opt.value"
                    class="vq-option" :class="{ 'vq-on': s.videoResolution === opt.value }"
                    @click="setQuality('videoResolution', opt.value)">{{ opt.label }}</button>
          </div>
          <div class="vq-group">
            <div class="vq-title">Quality</div>
            <button v-for="opt in qualityOptions" :key="opt.value"
                    class="vq-option" :class="{ 'vq-on': s.videoQuality === opt.value }"
                    @click="setQuality('videoQuality', opt.value)">{{ opt.label }}</button>
          </div>
          <div class="vq-group">
            <div class="vq-title">Encoding speed</div>
            <button v-for="opt in speedOptions" :key="opt.value"
                    class="vq-option" :class="{ 'vq-on': s.encodeSpeed === opt.value }"
                    @click="setQuality('encodeSpeed', opt.value)">{{ opt.label }}</button>
          </div>
          <div class="vq-group">
            <div class="vq-title">Codec</div>
            <button v-for="opt in codecOptions" :key="opt.value"
                    class="vq-option" :class="{ 'vq-on': s.videoCodec === opt.value }"
                    :disabled="opt.value === 'hevc' && !hevcSupported"
                    @click="setQuality('videoCodec', opt.value)">{{ opt.label }}</button>
          </div>
          <p class="vq-note">Slower encoding = smaller files at the same quality, but uses more CPU/GPU. HEVC plays only on devices with hardware HEVC decoding — Auto picks it only when supported.</p>
        </div>

        <div class="vc-seek-row">
          <span class="vc-time">{{ fmt(currentTime) }}</span>
          <input class="vc-seek" type="range" min="0" :max="seekMax || 0" step="0.1"
                 :value="currentTime" :disabled="!seekMax" :style="seekStyle()"
                 @input="seekInput" @change="seekCommit" aria-label="Seek">
          <span class="vc-time vc-time-dur">{{ fmt(seekMax) }}</span>
        </div>

        <div class="vc-btn-row">
          <div class="vc-group">
            <button class="vc-btn" :disabled="!prevVideo" @click="goPrev" title="Previous video">
              <ui-icon name="skipPrev" :size="26"></ui-icon>
            </button>
            <button class="vc-btn vc-btn-play" @click="togglePlay" :title="isPlaying ? 'Pause' : 'Play'">
              <ui-icon :name="isPlaying ? 'pause' : 'play'" :size="30"></ui-icon>
            </button>
            <button class="vc-btn" :disabled="!nextVideo" @click="goNext" title="Next video">
              <ui-icon name="skipNext" :size="26"></ui-icon>
            </button>
            <button class="vc-btn" @click="toggleMute" :title="muted ? 'Unmute' : 'Mute'">
              <ui-icon :name="muted ? 'volumeOff' : 'volumeUp'" :size="26"></ui-icon>
            </button>
          </div>

          <div class="vc-group">
            <button class="vc-btn" @click="qualityOpen = !qualityOpen" title="Playback quality">
              <ui-icon name="tune" :size="24"></ui-icon>
            </button>
            <button class="vc-btn" :class="{ 'vc-btn-on': loopOn }" @click="toggleLoop"
                    :title="loopOn ? 'Loop on — tap to stop looping' : 'Loop this video'">
              <ui-icon name="loop" :size="24"></ui-icon>
            </button>
            <button class="vc-btn" @click="externalOpen = true" title="Open in external player">
              <ui-icon name="openExternal" :size="24"></ui-icon>
            </button>
            <button class="vc-btn" @click="toggleFullscreen" title="Fullscreen">
              <ui-icon name="fullscreen" :size="26"></ui-icon>
            </button>
          </div>
        </div>
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
            <p class="info-sub info-config">{{ activeConfig }}</p>
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
        <div v-else-if="s.showTranscodeInfo && useDirect" class="buffer-done">
          <ui-icon name="check" :size="18"></ui-icon> Direct play — no transcoding
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

    <!-- ── External player modal ─────────────────────────────────────── -->
    <div v-if="externalOpen" class="modal-root" @click.self="externalOpen = false">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Open in external player">
        <header class="modal-header">
          <h2>Open in external player</h2>
          <button class="icon-btn" @click="externalOpen = false" title="Close">
            <ui-icon name="close"></ui-icon>
          </button>
        </header>

        <p class="modal-note">
          Copy this direct link and open it in VLC, mpv, Infuse or any video app
          via “Open network stream”. The original file streams with full seeking support.
        </p>

        <div class="url-row">
          <input ref="rawInput" class="url-input" type="text" readonly
                 :value="rawUrl" @focus="$event.target.select()" spellcheck="false">
          <button class="btn primary" @click="copyLink">{{ copied ? 'Copied!' : 'Copy' }}</button>
        </div>

        <div class="scheme-grid">
          <a class="btn" :href="'vlc://' + rawUrl">Open in VLC</a>
          <a class="btn" :href="'nplayer-' + rawUrl">Open in nPlayer</a>
          <a class="btn" :href="rawUrl" target="_blank" rel="noopener">Open in browser</a>
        </div>

        <p v-if="hlsUrl" class="modal-note">
          Transcoded HLS link (for players that support HLS):
          <span class="url-text">{{ hlsUrl }}</span>
        </p>
      </div>
    </div>
  </div>
  `,
};
