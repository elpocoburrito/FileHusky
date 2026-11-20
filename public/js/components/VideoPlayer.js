/* ─── VideoPlayer: dedicated playback page ───────────────────────────────── */

/* global Vue, Utils, SettingsStore, Hls, CastStore, TvMode */

const VIDEO_EXT_DIRECT = new Set(['.mp4', '.m4v', '.mov', '.webm']);
const DIRECT_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
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
      playerVolume: 1,
      volHud: false,
      volHudTimer: null,
      loopOn: false,
      controlsVisible: true,
      hideTimer: null,
      currentTime: 0,
      bufferedPercent: 0,
      scrubbing: false,
      externalOpen: false,
      castOpen: false,
      copied: false,
      qualityOpen: false,
      pendingSeek: 0,          // restart-at-position (quality change)
      activeCodec: 'h264',     // codec actually in use for this session

      // ── Tagging overlay state ─────────────────────────────────────────
      tagsOpen: false,
      allTags: { groups: [], ungrouped: [] },  // available tags (from server)
      videoTagIds: [],         // tag ids applied to this video
      videoRating: null,       // 1–5 or null
      tagsLoading: false,
      isFullscreen: false,
      wallClock: '',            // HH:MM readout for the top bar
      clockTimer: null,
      landscape: false,         // orientation lock active

      // ── Casting / remote-control mode ──────────────────────────────────
      remote: false,            // local playback replaced by the remote panel
    };
  },

  computed: {
    s() { return SettingsStore.settings; },

    /** TV mode adds a transport button to the bottom bar (no click surface). */
    tvMode() { return TvMode.state.enabled; },

    // ── Casting session ────────────────────────────────────────────────
    cast() { return CastStore.state; },

    receiverName() {
      return (this.cast.receiver && this.cast.receiver.name) || 'receiver';
    },

    remoteStatusText() {
      if (this.cast.error) return this.cast.error;
      const pb = this.cast.playback;
      if (!pb) return 'Connecting…';
      switch (pb.status) {
        case 'playing': return 'Playing';
        case 'paused': return 'Paused';
        case 'loading': return 'Loading…';
        case 'error': return 'Playback error' + (pb.error ? ': ' + pb.error : '');
        case 'stopped': return 'Stopped';
        default: return 'Idle';
      }
    },

    // Duration shown on the seek bar — receiver duration while casting
    displayDuration() {
      if (!this.remote) return this.seekMax;
      const pb = this.cast.playback;
      return (pb && pb.duration) || (this.meta && this.meta.duration) || 0;
    },

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
      return this.displayDuration ? Math.min(100, this.currentTime / this.displayDuration * 100) : 0;
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
      const okVideo = DIRECT_VIDEO_CODECS.has(this.meta.codec) &&
        (this.meta.codec !== 'h264' || !this.meta.pixFmt || /^yuvj?420p$/.test(this.meta.pixFmt));
      const okAudio = !this.meta.audioCodec || DIRECT_AUDIO_CODECS.has(this.meta.audioCodec);
      return VIDEO_EXT_DIRECT.has(ext) && okVideo && okAudio;
    },

    useDirect() {
      // 'Original' + browser-compatible file → stream the file directly,
      // no transcoding. Falls back to transcode for incompatible files.
      return this.s.videoResolution === 'orig' && this.canDirectPlay;
    },

    activeConfig() {
      if (this.remote) {
        const how = { 'hls-transcode': 'transcoding', 'direct-file': 'direct play', 'local-file': 'local file' }[this.cast.backend];
        return 'Casting to ' + this.receiverName + (how ? ' · ' + how : '');
      }
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
      // A manual orientation choice applies to the video it was made on
      this._manualOrientation = false;
      this.start();
      this.loadUpNext();
      this.loadVideoTags();
    },

    // Receiver state pushed by the polling loop
    'cast.playback'(pb) {
      this.onCastPlayback(pb);
    },

    // Ready to play: in TV mode the remote should land on the player controls
    // (they only exist once the phase is `ready`).
    phase(value) {
      if (value !== 'ready' || !TvMode.state.enabled) return;
      const active = document.activeElement;
      if (active && active.closest && active.closest('.video-area')) return;
      setTimeout(() => {
        if (!TvMode.state.enabled) return;
        // Loading hides the control bar (v-show), which drops the focus to
        // <body>. Coming back, the user should land on the control they were
        // using — pressing “next” keeps the cursor on “next”, not on play.
        const remembered = this._tvLastControl;
        if (remembered && remembered.isConnected && !remembered.disabled
            && remembered.getClientRects().length) {
          TvMode.focusElement(remembered, false);
          return;
        }
        TvMode.focusFirst(false);
      }, 60);
    },

    // Casting session started/stopped elsewhere (CastPanel, disconnect…)
    'cast.active'(active) {
      this.onCastActive(active);
    },

    // Keep player UI visible while any overlay/menu is open; resume auto-hide on close
    qualityOpen(open) { if (open) this.showControls(); else this.scheduleHide(); },
    tagsOpen(open) { if (open) this.showControls(); else this.scheduleHide(); },
    castOpen(open) { if (open) this.showControls(); else this.scheduleHide(); },
    externalOpen(open) { if (open) this.showControls(); else this.scheduleHide(); },
  },

  // TV mode adds document-level focus/input listeners here so the overlay
  // auto-hides while playing and wakes cleanly on any remote/gamepad press.
  async mounted() {
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('focusin', this.onTvFocusIn);
    document.addEventListener('tv-input', this.onTvInput);
    document.addEventListener('tv-gamepad-action', this.onTvGamepadAction);
    document.addEventListener('tv-back', this.onTvBack);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('orientationchange', this.onOrientationChange);
    window.addEventListener('pagehide', this.onPageHide);
    this.onOrientationChange();
    this.startClock();
    await this.start();
    if (this.folder) this.loadUpNext();
    this.loadVideoTags();
  },

  beforeUnmount() {
    this._startSeq = (this._startSeq || 0) + 1; // invalidate any in-flight start()
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('focusin', this.onTvFocusIn);
    document.removeEventListener('tv-input', this.onTvInput);
    document.removeEventListener('tv-gamepad-action', this.onTvGamepadAction);
    document.removeEventListener('tv-back', this.onTvBack);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    document.removeEventListener('orientationchange', this.onOrientationChange);
    window.removeEventListener('pagehide', this.onPageHide);
    this.stopClock();
    this.clearHideTimer();
    this.savePosition();
    this.cleanup();
  },

  methods: {
    /** Tear down a server-side transcode session immediately to free GPU/disk. */
    stopServerStream(streamId, useBeacon) {
      if (!streamId) return;
      const url = '/api/video/stream/' + encodeURIComponent(streamId);
      if (useBeacon && navigator.sendBeacon) {
        try { navigator.sendBeacon(url + '/stop'); return; } catch {}
      }
      fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
    },

    onPageHide() {
      if (this.stream && this.stream.streamId) {
        this.stopServerStream(this.stream.streamId, true);
      }
    },

    /** Resolve target start timestamp (explicit seek or saved resume point). */
    resolveResumeSeconds() {
      let target = this.pendingSeek || 0;
      this.pendingSeek = 0;
      if (!target && this.s.resumePlayback) {
        const saved = parseFloat(localStorage.getItem('srvfiles-resume:' + this.path) || '0');
        if (saved > 15 && this.meta && this.meta.duration && saved < this.meta.duration - 30) {
          target = saved;
        }
      }
      return target;
    },

    async start() {
      const seq = (this._startSeq = (this._startSeq || 0) + 1);
      // Keep the current frame attached while the next source is prepared.
      this.cleanup(true);
      // Swapping the media source can make the browser drop the orientation
      // lock, so re-assert it immediately instead of waiting for the new
      // video's metadata (which leaves a visible portrait hop).
      if (this._wantOrientation === 'landscape' && this.isFullscreen && this.isTouchDevice()) {
        this.lockOrientation('landscape');
        this.holdLandscape();
      }
      this.remote = false;
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

      // A casting session is active: this page becomes a remote control for
      // the receiver instead of playing locally.
      if (CastStore.state.active) {
        await this.startRemote();
        return;
      }

      try {
        // 1. Metadata (duration, resolution) — shown immediately
        const meta = await Utils.api('/api/video/metadata?path=' + encodeURIComponent(this.path));
        if (seq !== this._startSeq) return; // superseded by another navigation
        this.meta = meta;
        this.resumeSeconds = this.resolveResumeSeconds();

        if (this.useDirect) {
          // Direct play: no transcode session needed
          this.stream = null;
          await this.attachPlayer();
          if (seq !== this._startSeq) return;
          this.phase = 'ready';
          this.statusText = 'Playing';
          return;
        }

        // 2. Start transcode session with current quality settings + start offset
        this.statusText = 'Starting transcoder…';
        const requestedCodec = this.s.videoCodec === 'auto'
          ? (hevcSupported() ? 'hevc' : 'h264')
          : this.s.videoCodec;
        let params = 'res=' + encodeURIComponent(this.s.videoResolution) +
          '&cq=' + encodeURIComponent(this.s.videoQuality) +
          '&speed=' + encodeURIComponent(this.s.encodeSpeed) +
          '&codec=' + encodeURIComponent(requestedCodec);
        if (this.resumeSeconds > 0) {
          params += '&start=' + encodeURIComponent(this.resumeSeconds.toFixed(1));
        }
        const stream = await Utils.api('/api/video/stream/start?path=' +
          encodeURIComponent(this.path) + '&' + params);
        if (seq !== this._startSeq) {
          // Superseded while starting — immediately clean up the orphaned session
          this.stopServerStream(stream.streamId);
          return;
        }
        this.stream = stream;
        this.activeCodec = stream.activeCodec || requestedCodec;
        this.totalSegments = stream.segments;
        this.cachedSegments = 0;

        // 3. Attach player
        await this.attachPlayer();
        if (seq !== this._startSeq) return;

        this.phase = 'ready';
        this.statusText = 'Playing';
        this.startStatusPolling();
      } catch (e) {
        if (seq !== this._startSeq) return;
        this.phase = 'error';
        this.errorMsg = e.message;
      }
    },

    /**
     * Remote-control mode: no local playback. If the active session is
     * already casting a different file, this video is cast to the receiver
     * (auto-cast on open); otherwise we just mirror the receiver state.
     */
    async startRemote() {
      // Stop any local playback (this path can be entered directly from the
      // CastPanel without going through start()).
      this.cleanup();
      this.stream = null;
      this.totalSegments = 0;
      this.cachedSegments = 0;
      this.remote = true;
      this.phase = 'loading';
      this.errorMsg = null;
      this.statusText = 'Connecting to receiver…';
      this.isPlaying = false;
      this.currentTime = 0;
      this.bufferedPercent = 0;
      this.scrubbing = false;
      this.controlsVisible = true;
      this.fullyCached = false;

      try {
        this.meta = await Utils.api('/api/video/metadata?path=' + encodeURIComponent(this.path));
      } catch { this.meta = null; }

      if (CastStore.state.path !== this.path) {
        try {
          await CastStore.cast({
            path: this.path,
            name: this.displayName,
            folder: this.folder,
            receiver: CastStore.state.receiver,
          });
        } catch (e) {
          this.phase = 'error';
          this.errorMsg = 'Could not cast to receiver: ' + e.message;
          return;
        }
      } else {
        CastStore.startPolling();
      }

      this.onCastPlayback(CastStore.state.playback);
      this.phase = 'ready';
      this.statusText = 'Casting to ' + this.receiverName;
    },

    /** Session toggled from outside this component. */
    onCastActive(active) {
      if (active) {
        if (!this.remote && CastStore.state.path === this.path) this.startRemote();
        return;
      }
      if (!this.remote) return;
      // Session ended (e.g. disconnect from another view): resume locally
      const pos = this._resumeAfterCast || 0;
      this._resumeAfterCast = 0;
      this.remote = false;
      this.pendingSeek = pos;
      this.start();
    },

    /** Mirror a receiver PlaybackState onto the UI. */
    onCastPlayback(pb) {
      if (!this.remote || !pb) return;
      if (typeof pb.volume === 'number') {
        if (pb.volume > 0) { this.playerVolume = pb.volume; this.muted = false; }
        else this.muted = true;
      }
      this.isPlaying = pb.status === 'playing';
      if (!this.scrubbing) this.currentTime = Number(pb.position) || 0;
    },

    remoteSeekRelative(delta) {
      CastStore.seekRelative(delta).catch(() => {});
      this.showControls();
    },

    /** Stop the receiver's playback but stay in remote mode. */
    stopReceiver() {
      CastStore.stop().catch(() => {});
    },

    /** Leave remote mode and continue watching on this device. */
    async watchHere() {
      this._resumeAfterCast = (this.cast.playback && this.cast.playback.position) || 0;
      try { await CastStore.disconnect(); } catch { /* session still ends */ }
    },

    async attachPlayer() {
      const player = this.$refs.video;

      // Attach loadedmetadata handler (tracked so cleanup() can remove it if
      // the user navigates away before metadata finishes loading).
      const resumeAt = this.resumeSeconds;
      const usingHlsJs = !this.useDirect && !!(window.Hls && Hls.isSupported());
      this._onLoaded = () => {
        // Dimensions are known now: when the player is already fullscreen
        // (e.g. moving to the next video), re-apply the orientation so a new
        // portrait video is not left locked in landscape from the previous one.
        this.clearOrientationRetry();
        if (this.isFullscreen) this.applyAutoOrientation();
        if (resumeAt > 0) {
          // hls.js already starts at `startPosition`; seek explicitly for
          // direct play and native HLS (or if hls.js landed far off).
          if (!usingHlsJs || Math.abs(player.currentTime - resumeAt) > 2) {
            player.currentTime = resumeAt;
          }
          this.statusText = 'Resumed at ' + Utils.formatDuration(resumeAt);
          setTimeout(() => { if (this.statusText.startsWith('Resumed')) this.statusText = 'Playing'; }, 4000);
        }
        if (this.s.autoplay) {
          player.play().catch(() => { /* autoplay blocked */ });
        }
        player.removeEventListener('loadedmetadata', this._onLoaded);
        this._onLoaded = null;
      };
      player.addEventListener('loadedmetadata', this._onLoaded);

      // iOS enters fullscreen on the <video> element itself (there is no
      // document.fullscreenElement), so mirror those events into UI state.
      if (!this._webkitFsBound) {
        this._webkitFsBound = true;
        this._onWebkitBeginFs = () => this.syncFullscreenState(true);
        this._onWebkitEndFs = () => this.syncFullscreenState(false);
        player.addEventListener('webkitbeginfullscreen', this._onWebkitBeginFs);
        player.addEventListener('webkitendfullscreen', this._onWebkitEndFs);
      }

      if (this.useDirect) {
        // Direct play of the original file (browser-compatible sources)
        player.src = this.rawUrl;
      } else if (usingHlsJs) {
        const restartStream = () => {
          const p = this.$refs.video;
          this.pendingSeek = (p && p.currentTime) ? p.currentTime : resumeAt;
          this.statusText = 'Recovering…';
          setTimeout(() => this.start(), 50);
        };
        this.hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          startPosition: resumeAt > 0 ? resumeAt : -1,
          backBufferLength: 30,
          maxBufferLength: 40,
          maxMaxBufferLength: 60,
          // Segments are transcoded on demand — a seek to an uncached
          // position can take several seconds, so wait patiently instead
          // of failing fast
          fragLoadingTimeOut: 60000,
          fragLoadingMaxRetry: 6,
          fragLoadingRetryDelay: 500,
          fragLoadingMaxRetryTimeout: 12000,
          manifestLoadingTimeOut: 30000,
          manifestLoadingMaxRetry: 4,
          levelLoadingTimeOut: 30000,
          levelLoadingMaxRetry: 4,
        });
        this.hls.loadSource(this.stream.playlistUrl);
        this.hls.attachMedia(player);
        this.hls.on(Hls.Events.ERROR, (_event, data) => {
          // 404 means the server-side transcode session expired while paused:
          // recreate it immediately instead of burning ~30 s on retries.
          const httpCode = data && data.response && data.response.code;
          if (httpCode === 404 && !this._restarting404) {
            this._restarting404 = true;
            this._recoveries = (this._recoveries || 0) + 1;
            if (this._recoveries <= 3) { restartStream(); return; }
          }
          if (!data.fatal) return;
          // Recoverable failures (e.g. seeked into an un-transcoded position,
          // or the transcode session expired): restart the stream seamlessly
          // at the current position instead of killing playback.
          this._recoveries = (this._recoveries || 0) + 1;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this._recoveries <= 2) {
            this.hls.recoverMediaError();
            return;
          }
          if (this._recoveries <= 3) {
            restartStream();
            return;
          }
          this.phase = 'error';
          this.errorMsg = 'Playback error: ' + (data.details || data.type || 'unknown') +
            '. The transcode session may have expired.';
          this.cleanup();
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
      player.addEventListener('playing', this.onPlayingUi);
      this.muted = player.muted;
      this._restarting404 = false;
    },

    /** Healthy playback for 10s clears the error-recovery budget */
    onPlayingUi() {
      clearTimeout(this._recoverResetTimer);
      this._recoverResetTimer = setTimeout(() => { this._recoveries = 0; }, 10000);
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
      // While casting, a quality change re-casts the file with a new
      // transcode session (the receiver keeps playing through it).
      if (this.remote) {
        CastStore.cast({
          path: this.path,
          name: this.displayName,
          folder: this.folder,
          receiver: CastStore.state.receiver,
        }).catch(e => { this.errorMsg = e.message; });
        return;
      }
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
      } catch {
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
      } catch { /* folder may be gone; ignore */ }
    },

    openVideo(item) {
      this.savePosition();
      // Replace (not push) so watching N videos doesn't stack N history
      // entries — the back button should always return to the file browser
      this.$router.replace({
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

    /**
     * Tear down the current playback.
     *
     * `keepMedia` leaves the <video> attached to its last source instead of
     * blanking it. Blanking it in fullscreen makes Firefox for Android
     * re-evaluate its fullscreen/orientation state while the element holds no
     * media, which rotates the screen to portrait until the next source loads.
     * It also removes a black flash between videos.
     */
    cleanup(keepMedia) {
      this.stopStatusPolling();
      if (this.stream && this.stream.streamId) {
        this.stopServerStream(this.stream.streamId);
        this.stream = null;
      }
      if (this.hls) { this.hls.destroy(); this.hls = null; }
      const player = this.$refs.video;
      if (player) {
        if (this._onLoaded) {
          player.removeEventListener('loadedmetadata', this._onLoaded);
          this._onLoaded = null;
        }
        player.removeEventListener('timeupdate', this.onTimeUpdate);
        player.removeEventListener('ended', this.onEnded);
        player.removeEventListener('timeupdate', this.onTimeUi);
        player.removeEventListener('play', this.onPlayPauseUi);
        player.removeEventListener('pause', this.onPlayPauseUi);
        player.removeEventListener('volumechange', this.onVolumeUi);
        player.removeEventListener('progress', this.onBufferUi);
        player.removeEventListener('playing', this.onPlayingUi);
        clearTimeout(this._recoverResetTimer);
        this.clearOrientationRetry();
        if (this._onWebkitBeginFs) {
          player.removeEventListener('webkitbeginfullscreen', this._onWebkitBeginFs);
          player.removeEventListener('webkitendfullscreen', this._onWebkitEndFs);
          this._webkitFsBound = false;
        }
        player.pause();
        if (!keepMedia) {
          player.removeAttribute('src');
          player.load();
        }
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
        if (this._silentPause) {
          // Paused silently via Space / gamepad A while fullscreen & hidden
          this._silentPause = false;
          this.clearHideTimer();
          return;
        }
        this.controlsVisible = true;
        this.clearHideTimer();
      } else {
        this._silentPause = false;
        if (this.controlsVisible) this.scheduleHide();
      }
    },

    /** Toggle play/pause without revealing a hidden fullscreen overlay. */
    togglePlaySilent() {
      this._silentPause = true;
      clearTimeout(this._silentPauseTimer);
      this._silentPauseTimer = setTimeout(() => { this._silentPause = false; }, 300);
      this.togglePlay();
    },

    onVolumeUi() {
      const player = this.$refs.video;
      if (!player) return;
      this.muted = player.muted || player.volume === 0;
      this.playerVolume = player.volume;
    },

    // Heuristic: true when the primary input is touch (phones/tablets).
    // Used to show the orientation button; combined with isFullscreen in
    // the template so it never appears on desktop.
    isTouchDevice() {
      return (typeof window !== 'undefined' &&
        ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0));
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
      if (this.remote) {
        CastStore.toggle().catch(() => {});
        this.showControls();
        return;
      }
      const player = this.$refs.video;
      if (!player) return;
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    },

    toggleMute() {
      if (this.remote) {
        const target = this.muted ? (this.playerVolume || 0.5) : 0;
        CastStore.setVolume(target).catch(() => {});
        if (target > 0) { this.playerVolume = target; this.muted = false; }
        else this.muted = true;
        this.showVolHud();
        return;
      }
      const player = this.$refs.video;
      if (!player) return;
      player.muted = !player.muted;
    },

    /** Volume slider (hover bar next to the mute button) */
    onVolSlider(e) {
      const v = parseFloat(e.target.value);
      if (this.remote) {
        if (v > 0) this.playerVolume = v;
        this.muted = v === 0;
        CastStore.setVolume(v).catch(() => {});
        this.showVolHud();
        return;
      }
      const player = this.$refs.video;
      if (!player) return;
      player.volume = v;
      if (player.muted && v > 0) player.muted = false;
      this.showVolHud();
    },

    volStyle() {
      const pct = this.muted ? 0 : this.playerVolume * 100;
      return {
        background: 'linear-gradient(to right,' +
          ' var(--accent) 0%, var(--accent) ' + pct + '%,' +
          ' rgba(255,255,255,.35) ' + pct + '%, rgba(255,255,255,.35) 100%)',
      };
    },

    toggleLoop() {
      const player = this.$refs.video;
      if (!player) return;
      player.loop = !player.loop;
      this.loopOn = player.loop;
    },

    toggleFullscreen() {
      // While casting, fullscreen is toggled on the receiver's screen.
      if (this.remote) {
        CastStore.fullscreen().catch(() => {});
        return;
      }
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
      const t = parseFloat(e.target.value);
      this.scrubbing = false;
      this.currentTime = t;
      if (this.remote) {
        CastStore.seek(t).catch(() => {});
        this.scheduleHide();
        return;
      }
      const player = this.$refs.video;
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

    /**
     * Tap handling for the whole playback surface, driven by pointer events.
     *
     * `click` cannot be trusted here: mobile browsers do not reliably deliver
     * it to a <video> element, and the app-wide double-tap zoom blocker in
     * index.html calls preventDefault() on touchend (which kills the
     * synthesized click) for any tap within 300 ms of the previous one.
     * Pointer events are never suppressed that way, so a pointerup that did
     * not drag becomes a tap.
     */
    onPointerUp(e) {
      const down = this._down;
      this._down = null;
      if (this.phase !== 'ready' || !down) return;
      // Taps that start or end on a control / overlay are never UI toggles
      if (this.isControlTarget(e.target) || this.isControlTarget(down.target)) return;
      if (this.qualityOpen) { this.qualityOpen = false; return; }
      // Drag (scrubbing, scrolling) or long-press: not a tap
      const dx = (e.clientX || 0) - down.x;
      const dy = (e.clientY || 0) - down.y;
      if (Math.sqrt(dx * dx + dy * dy) > 12) return;
      if (Date.now() - down.t > 700) return;

      if (down.type !== 'mouse') {
        // Touch: a tap anywhere opens/closes the player UI. The browser then
        // dispatches a synthesized click at these coordinates — by now the UI
        // may be visible, so that click would land on a freshly shown button.
        // Swallow it (see onCaptureClick).
        this._suppressClickUntil = Date.now() + 500;
        this.togglePlayerUi();
        return;
      }
      // Desktop: single click = play/pause, deferred so a double-click can
      // take over and toggle fullscreen instead (same timing as before).
      if (this._clickTimer) {
        clearTimeout(this._clickTimer);
        this._clickTimer = null;
        this.toggleFullscreen();
        return;
      }
      this._clickTimer = setTimeout(() => {
        this._clickTimer = null;
        this.togglePlay();
      }, 260);
    },

    /**
     * Swallow the click synthesized right after a UI-toggling tap, so it does
     * not activate a control that the same tap just revealed.
     */
    onCaptureClick(e) {
      if (!this._suppressClickUntil) return;
      if (Date.now() > this._suppressClickUntil) {
        this._suppressClickUntil = 0;
        return;
      }
      this._suppressClickUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    },

    /** True when the element belongs to a player control or overlay. */
    isControlTarget(el) {
      if (!el || !el.closest) return false;
      return !!el.closest('.vcontrols, .vc-top, .vc-center, .remote-panel, .tag-fs, ' +
        '.vc-quality, .quality-backdrop, .video-overlay');
    },

    /** Show/hide the player UI overlay (top bar, bottom bar, center button) */
    togglePlayerUi() {
      if (this.controlsVisible) this.hideControls();
      else this.showControls();
    },

    /** Hide the player UI; an open quality menu goes with it. */
    hideControls() {
      this.clearHideTimer();
      this.qualityOpen = false;
      this.controlsVisible = false;
      // In TV mode, if focus was on a control inside the player, park it
      // silently on .video-area (no visible ring) so the video plays cleanly
      // and the next remote/gamepad press wakes the overlay right back up.
      if (!TvMode.state.enabled || this.remote) return;
      const area = this.$refs.videoArea;
      const cur = document.activeElement;
      if (!area || !cur || cur === area || !area.contains(cur)) return;
      this._tvLastControl = cur;
      this.$nextTick(() => {
        if (this.controlsVisible || !area.isConnected) return;
        this._parkingHiddenFocus = true;
        try {
          TvMode.focusElement(area, false);
        } finally {
          this._parkingHiddenFocus = false;
        }
      });
    },

    /** Restore TV focus to the last player control (or play/pause) once UI is shown. */
    wakePlayerUi() {
      this.showControls();
      this.$nextTick(() => {
        if (!TvMode.state.enabled || !this.controlsVisible) return;
        const area = this.$refs.videoArea;
        if (!area) return;
        const remembered = this._tvLastControl;
        if (remembered && remembered !== area && area.contains(remembered) &&
            !remembered.disabled && remembered.getClientRects().length) {
          TvMode.focusElement(remembered, false);
          return;
        }
        const fallback = area.querySelector('.vc-center, .vcontrols button:not([disabled])');
        if (fallback) TvMode.focusElement(fallback, false);
      });
    },

    /**
     * Resolve a pointer event's type. Touch devices synthesise compatibility
     * *mouse* events after a tap, so an absent pointerType must never be read
     * as a mouse — that is what made a tap re-reveal the UI it had just hidden.
     */
    pointerTypeOf(e) {
      return (e && e.pointerType) || (this.isTouchDevice() ? 'touch' : 'mouse');
    },

    /** Handle incoming TV remote/keyboard/gamepad activity: silent pause, wake hidden UI, or reset timer. */
    onTvInput(e) {
      if (!TvMode.state.enabled || this.phase !== 'ready' || this.remote) return;
      const area = this.$refs.videoArea;
      const cur = document.activeElement;
      const inPlayer = !!area && !!cur && area.contains(cur);
      const kind = e.detail && e.detail.kind;
      const source = e.detail && e.detail.source;
      if (!this.controlsVisible) {
        // Fullscreen + hidden overlay: Space / gamepad A toggles play/pause silently
        // (keeps overlay hidden until a direction key or other wake press).
        if (this.isFullscreen && (source === 'space' || source === 'gamepad-a')) {
          e.preventDefault();
          this.togglePlaySilent();
          return;
        }
        // Any other non-back press wakes the overlay without activating blindly.
        if ((inPlayer || this.isFullscreen) && kind !== 'back') {
          e.preventDefault();
          this.wakePlayerUi();
        }
        return;
      }
      if (inPlayer || this.isFullscreen) this.scheduleHide();
    },

    /** Xbox-layout gamepad hotkeys (TV mode): X quality, Y loop, LT prev, RT next, Start fullscreen. */
    onTvGamepadAction(e) {
      if (!TvMode.state.enabled || this.phase !== 'ready') return;
      const action = e.detail && e.detail.action;
      const settingsOpen = Boolean(document.querySelector('.settings-root'));
      if (action === 'quality') {
        if (this.externalOpen || this.castOpen || this.tagsOpen || settingsOpen) return;
        this.qualityOpen = !this.qualityOpen;
        if (this.qualityOpen) {
          this.showControls();
          this.$nextTick(() => {
            if (TvMode.state.enabled && this.qualityOpen) TvMode.focusFirst(false);
          });
        } else {
          this.wakePlayerUi();
        }
        return;
      }
      if (this.qualityOpen || this.tagsOpen || this.castOpen || this.externalOpen || settingsOpen) return;
      switch (action) {
        case 'fullscreen': this.toggleFullscreen(); break;
        case 'prev': this.goPrev(); break;
        case 'next': this.goNext(); break;
        case 'loop':
          this.toggleLoop();
          if (this.controlsVisible) this.scheduleHide();
          break;
      }
    },

    /** TV focus entered or left the player — wake hidden overlay or remember active control */
    onTvFocusIn(e) {
      const el = e.target;
      if (!el || el === document.body) return;
      const area = this.$refs.videoArea;
      if (area && el === area) {
        // Focus arrived on .video-area from the queue or header while controls
        // were hidden: wake the overlay and hand focus to a real control.
        if (!this._parkingHiddenFocus && TvMode.state.enabled && this.phase === 'ready' && !this.controlsVisible) {
          this.wakePlayerUi();
        }
        return;
      }
      if (el.closest && el.closest('.video-area')) {
        // Remember which control the remote is on, so a media change (prev/next)
        // or UI wake-up restores focus there instead of jumping back to play/pause.
        this._tvLastControl = el;
        if (TvMode.state.enabled && this.phase === 'ready') this.showControls();
      } else if (!el.closest || !el.closest('.modal-root, .settings-root, .vc-quality, .tag-fs')) {
        // Focus moved intentionally to the queue/header — don't reuse an old player button
        this._tvLastControl = null;
      }
    },

    /** TV Backspace closes the non-fullscreen tag panel or open player modals first. */
    onTvBack(e) {
      if (this.externalOpen) { e.preventDefault(); this.externalOpen = false; return; }
      if (this.castOpen) { e.preventDefault(); this.castOpen = false; return; }
      if (this.qualityOpen) { e.preventDefault(); this.qualityOpen = false; return; }
      if (this.tagsOpen) { e.preventDefault(); this.tagsOpen = false; }
    },

    /** Pointer moved over the player — reveal controls (mouse only) */
    onPointerMove(e) {
      if (this.pointerTypeOf(e) !== 'mouse') return;
      if (this.phase === 'ready') this.showControls();
    },

    /** A cancelled pointer (scroll/gesture took over) is never a tap. */
    onPointerCancel() {
      this._down = null;
    },

    /** Record the pointer type and origin at press time (used by onPointerUp) */
    onPointerDown(e) {
      // A new press starts a fresh interaction: never let a stale suppression
      // window swallow a legitimate control click.
      this._suppressClickUntil = 0;
      const type = e.pointerType || (this.isTouchDevice() ? 'touch' : 'mouse');
      this._downPointerType = type;
      this._down = {
        type,
        x: e.clientX || 0,
        y: e.clientY || 0,
        t: Date.now(),
        target: e.target,
      };
      if (type === 'mouse') this.onPointerMove(e);
    },

    /** Mouse left the player — hide sooner than the touch idle timer */
    onMouseLeave(e) {
      if (this.pointerTypeOf(e) !== 'mouse') return;
      if (!this.isPlaying) return; // paused keeps controls visible anyway
      this.clearHideTimer();
      this.hideTimer = setTimeout(() => this.hideControls(), 800);
    },

    // ── Wall-clock readout (top bar) ──────────────────────────────────
    startClock() {
      const tick = () => {
        const d = new Date();
        this.wallClock = String(d.getHours()).padStart(2, '0') + ':' +
          String(d.getMinutes()).padStart(2, '0');
      };
      tick();
      this.clockTimer = setInterval(tick, 15000);
    },

    stopClock() {
      if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
    },

    // ── Orientation (mobile only) ────────────────────────────────────
    onOrientationChange() {
      const type = (screen.orientation && screen.orientation.type) || '';
      this.landscape = type.startsWith('landscape');
    },

    /**
     * Toggle orientation lock landscape/portrait. Only shown in fullscreen
     * on touch devices. Chrome/Android support the lock API; iOS Safari
     * does not — there we rely on fullscreen + the device's auto-rotate.
     */
    async toggleOrientation() {
      const want = this.landscape ? 'portrait' : 'landscape';
      // Remember the explicit choice so auto-orientation does not undo it
      this._manualOrientation = true;
      if (await this.lockOrientation(want)) return;
      // Fallback (iOS): cycle fullscreen so the OS auto-rotate can take over.
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          if (this.$refs.videoArea && this.$refs.videoArea.requestFullscreen) {
            await this.$refs.videoArea.requestFullscreen();
          }
        }
      } catch { /* nothing else we can do */ }
    },

    /** Download the original file via the existing raw endpoint (no re-encode) */
    doSaveVideo() {
      const a = document.createElement('a');
      a.href = this.rawUrl;
      a.download = this.displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    },

    /** Mouse scroll wheel over the player: adjust volume, show a % HUD */
    onWheel(e) {
      if (this.phase !== 'ready' || this.tagsOpen) return; // tag panel scrolls, not volume
      const step = e.deltaY < 0 ? 0.05 : -0.05;
      if (this.remote) {
        const cur = this.muted ? 0 : this.playerVolume;
        const next = Math.min(1, Math.max(0, cur + step));
        if (next > 0) this.playerVolume = next;
        this.muted = next === 0;
        CastStore.setVolume(next).catch(() => {});
        this.showVolHud();
        this.showControls();
        return;
      }
      const player = this.$refs.video;
      if (!player) return;
      const next = Math.min(1, Math.max(0, player.volume + step));
      player.volume = next;
      if (player.muted && (next > 0 || step > 0)) player.muted = false;
      this.showVolHud();
      this.showControls();
    },

    /** Flash the volume % readout while the volume is being changed */
    showVolHud() {
      this.volHud = true;
      clearTimeout(this.volHudTimer);
      this.volHudTimer = setTimeout(() => { this.volHud = false; }, 900);
    },

    showControls() {
      this.controlsVisible = true;
      this.scheduleHide();
    },

    scheduleHide() {
      this.clearHideTimer();
      if (this.remote || this.qualityOpen || this.tagsOpen || this.castOpen || this.externalOpen) return;
      const player = this.$refs.video;
      if (!player || player.paused) return; // always show controls when paused
      this.hideTimer = setTimeout(() => this.hideControls(), 3000);
    },

    clearHideTimer() {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    },

    onKey(e) {
      if (this.externalOpen) {
        if (e.key === 'Escape') this.externalOpen = false;
        return;
      }
      if (this.phase !== 'ready' || this.castOpen || document.querySelector('.settings-root')) return;
      // While the tagging overlay is open, only Escape closes it — avoid
      // playback hotkeys (space/arrows) firing while working with tags
      if (this.tagsOpen) {
        if (e.key === 'Escape') this.tagsOpen = false;
        return;
      }
      const active = document.activeElement;
      const tag = (active && active.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && active.type !== 'range')) return;
      const player = this.$refs.video;
      if (!player) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (this.isFullscreen && !this.controlsVisible) this.togglePlaySilent();
          else this.togglePlay();
          break;
        case 'ArrowLeft':
          if (this.remote) CastStore.seekRelative(-10).catch(() => {});
          else player.currentTime = Math.max(0, player.currentTime - 10);
          break;
        case 'ArrowRight':
          if (this.remote) CastStore.seekRelative(10).catch(() => {});
          else player.currentTime = player.currentTime + 10;
          break;
        case 'k': case 'K': this.toggleMute(); break;
        case 'f': case 'F': this.toggleFullscreen(); break;
        case 'l': case 'L': this.toggleLoop(); break;
        case 'm': case 'M': this.goNext(); break;
        case 'n': case 'N': this.goPrev(); break;
        case 'p': case 'P': this.togglePlay(); break;
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
      } catch {
        // Fallback for browsers without clipboard permission
        const input = this.$refs.rawInput;
        if (input) { input.select(); document.execCommand('copy'); this.copied = true; setTimeout(() => { this.copied = false; }, 2000); }
      }
    },

    // ═══ Tagging overlay ══════════════════════════════════════════════════

    onFullscreenChange() {
      const area = this.$refs.videoArea;
      this.syncFullscreenState(!!area && document.fullscreenElement === area);
    },

    /** Mirror a fullscreen change into UI state and orientation handling. */
    syncFullscreenState(isFs) {
      this.isFullscreen = isFs;
      this.onOrientationChange();
      if (isFs) this.applyAutoOrientation();
      else this.unlockOrientation();
    },

    /**
     * Match the screen orientation to the current video while fullscreen.
     *
     * A landscape video on a portrait screen wastes most of the display, so it
     * locks landscape. A portrait video releases our lock again — otherwise a
     * landscape lock taken for the previous video would keep it sideways.
     * Only touch devices are rotated; desktop fullscreen is left alone.
     */
    applyAutoOrientation() {
      this.clearOrientationRetry();
      if (!this.isTouchDevice() || !this.isFullscreen) return;
      // An explicit choice from the orientation button wins until the next video
      if (this._manualOrientation) return;
      const dims = this.mediaDimensions();
      if (!dims) {
        // Dimensions unknown (media still swapping): keep the current lock
        // instead of flashing to portrait, and look again shortly.
        this._orientRetry = setTimeout(() => this.applyAutoOrientation(), 250);
        return;
      }
      if (dims.width < dims.height) {
        this.unlockOrientation();
        return;
      }
      this.lockOrientation('landscape');
      this.holdLandscape();
    },

    /**
     * Keep landscape locked for a short window after it is applied.
     *
     * Swapping the media source (next video, quality change, restart) can make
     * a browser drop the orientation lock, which flashes the screen back to
     * portrait until something re-locks it. Re-asserting every ~120 ms for a
     * moment keeps that transition imperceptible, whereas a single retry after
     * several hundred milliseconds leaves a visible portrait hop.
     */
    holdLandscape() {
      const until = Date.now() + 1500;
      const tick = () => {
        this._orientRetry = null;
        if (!this.isFullscreen || this._wantOrientation !== 'landscape') return;
        if (!this.landscape) this.lockOrientation('landscape');
        if (Date.now() < until) this._orientRetry = setTimeout(tick, 120);
      };
      this._orientRetry = setTimeout(tick, 120);
    },

    clearOrientationRetry() {
      clearTimeout(this._orientRetry);
      this._orientRetry = null;
    },

    /** Reliable pixel dimensions of the current media, or null when unknown. */
    mediaDimensions() {
      const player = this.$refs.video;
      if (player && player.videoWidth > 0 && player.videoHeight > 0) {
        return { width: player.videoWidth, height: player.videoHeight };
      }
      const m = this.meta;
      if (m && m.width > 0 && m.height > 0) {
        return { width: m.width, height: m.height };
      }
      return null;
    },

    /** True when the video being played is at least as wide as it is tall */
    mediaIsLandscape() {
      const dims = this.mediaDimensions();
      return !!dims && dims.width >= dims.height;
    },

    /** Best-effort screen-orientation lock (unsupported on iOS Safari). */
    async lockOrientation(want) {
      try {
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock(want);
          this.landscape = want === 'landscape';
          this._orientationLocked = true;
          this._wantOrientation = want;
          return true;
        }
      } catch { /* lock refused or unsupported */ }
      return false;
    },

    /** Release a lock taken by the player and fall back to the OS setting. */
    unlockOrientation() {
      this._wantOrientation = null;
      this.clearOrientationRetry();
      if (!this._orientationLocked) return;
      this._orientationLocked = false;
      try {
        if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      } catch { /* ignore */ }
      this.onOrientationChange();
    },

    async toggleTags() {
      this.tagsOpen = !this.tagsOpen;
      if (this.tagsOpen) {
        // Fresh tag list each time (it may have been edited on the tags page)
        await this.loadAllTags();
        this.showControls();
      }
    },

    async loadAllTags() {
      this.tagsLoading = true;
      try {
        this.allTags = await Utils.api('/api/tags');
      } catch { /* keep previous list */ }
      this.tagsLoading = false;
    },

    async loadVideoTags() {
      try {
        const data = await Utils.api('/api/video/tags?path=' + encodeURIComponent(this.path));
        this.videoTagIds = data.tags || [];
        this.videoRating = data.rating == null ? null : data.rating;
      } catch {
        this.videoTagIds = [];
        this.videoRating = null;
      }
    },

    /** Toggle a tag; exclusive groups deselect their siblings first */
    toggleTag(tag) {
      const i = this.videoTagIds.indexOf(tag.id);
      if (i >= 0) {
        this.videoTagIds.splice(i, 1);
      } else {
        if (tag.groupId != null) {
          // Radio behavior within the group: drop other tags of that group.
          // Need each tag's group membership — check across groups + ungrouped.
          const siblingIds = [];
          for (const g of this.allTags.groups) {
            if (g.id !== tag.groupId) continue;
            for (const t of g.tags) if (t.id !== tag.id) siblingIds.push(t.id);
          }
          this.videoTagIds = this.videoTagIds.filter(id => !siblingIds.includes(id));
        }
        this.videoTagIds.push(tag.id);
      }
      this.saveVideoTags();
    },

    /** n = 1–5, or null to clear. Clicking the current star clears it. */
    setRating(n) {
      this.videoRating = (n == null || this.videoRating === n) ? null : n;
      this.saveVideoTags();
    },

    /** Create a tag from the overlay and apply it to this video immediately */
    async createTag({ name, groupId }) {
      try {
        const tag = await Utils.api('/api/tags', { method: 'POST', body: { name, groupId } });
        const full = { id: tag.id, name: tag.name, groupId };
        if (groupId != null) {
          const g = this.allTags.groups.find(g => g.id === groupId);
          if (g) g.tags.push(full); else this.allTags.ungrouped.push(full);
        } else {
          this.allTags.ungrouped.push(full);
        }
        // Exclusive-group handling applies to the new tag as well
        this.toggleTag(full);
      } catch (e) {
        console.error('Create tag failed:', e);
      }
    },

    async saveVideoTags() {
      try {
        await Utils.api('/api/video/tags', {
          method: 'PUT',
          body: {
            path: this.path,
            tagIds: this.videoTagIds.slice(),
            rating: this.videoRating,
          },
        });
      } catch (e) {
        console.error('Saving tags failed:', e);
      }
    },

    openTagManager() {
      this.$router.push({ name: 'tags' });
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
        <button class="icon-btn" @click="openTagManager" title="Manage tags">
          <ui-icon name="label"></ui-icon>
        </button>
        <tv-toggle></tv-toggle>
        <button class="icon-btn" @click="$emit('open-settings')" title="Settings">
          <ui-icon name="settings"></ui-icon>
        </button>
      </div>
    </header>

    <!-- ── Sticky video area ─────────────────────────────────────────── -->
    <div class="video-area" ref="videoArea"
         :tabindex="(tvMode && phase === 'ready' && !controlsVisible && !remote) ? 0 : null"
         @pointerdown="onPointerDown" @pointerup="onPointerUp"
         @pointercancel="onPointerCancel" @pointerleave="onMouseLeave"
         @pointermove="onPointerMove" @wheel.prevent="onWheel"
         @click.capture="onCaptureClick"
         :class="{ 'vc-hide-cursor': !controlsVisible, 'vc-ui-hidden': !controlsVisible }">
      <video ref="video" class="video-el" playsinline preload="auto" v-show="!remote"></video>

      <!-- ── Remote-control panel (casting mode) ──────────────────────── -->
      <div v-if="remote" class="remote-panel">
        <div class="remote-badge">
          <ui-icon name="cast" :size="18"></ui-icon>
          <span>Casting to {{ receiverName }}</span>
        </div>
        <div class="remote-title">
          {{ (cast.playback && cast.playback.title) || displayName }}
        </div>
        <div class="remote-status"
             :class="{ 'remote-status-err': cast.error || (cast.playback && cast.playback.status === 'error'),
                       'remote-status-ok': cast.playback && cast.playback.status === 'playing' }">
          {{ remoteStatusText }}
        </div>
        <div class="remote-actions">
          <button class="remote-btn" @click="remoteSeekRelative(-10)" title="Back 10 seconds">
            <ui-icon name="fastRewind" :size="30"></ui-icon>
          </button>
          <button class="remote-btn remote-btn-main" @click="togglePlay"
                  :title="isPlaying ? 'Pause' : 'Play'" :aria-label="isPlaying ? 'Pause' : 'Play'">
            <ui-icon :name="isPlaying ? 'pause' : 'play'" :size="48"></ui-icon>
          </button>
          <button class="remote-btn" @click="remoteSeekRelative(10)" title="Forward 10 seconds">
            <ui-icon name="fastForward" :size="30"></ui-icon>
          </button>
          <button class="remote-btn" @click="stopReceiver" title="Stop on receiver">
            <ui-icon name="stop" :size="28"></ui-icon>
          </button>
        </div>
        <button class="remote-disconnect" @click="watchHere">
          <ui-icon name="close" :size="18"></ui-icon> Disconnect &amp; watch here
        </button>
      </div>

      <!-- ── Top bar: video title, wall clock, download/external/tags ── -->
      <transition name="vc-fade">
        <div v-show="phase === 'ready' && controlsVisible" class="vc-top" @click.stop>
          <span class="vc-title">{{ displayName }}</span>
          <div class="vc-top-right">
            <span class="vc-clock">{{ wallClock }}</span>
            <button class="vc-btn vc-btn-sm" @click="doSaveVideo" title="Save video (original file)">
              <ui-icon name="download" :size="22"></ui-icon>
            </button>
            <button class="vc-btn vc-btn-sm" @click="castOpen = true" title="Cast to receiver">
              <ui-icon name="cast" :size="22"></ui-icon>
            </button>
            <button class="vc-btn vc-btn-sm" @click="externalOpen = true" title="Open in external player">
              <ui-icon name="openExternal" :size="22"></ui-icon>
            </button>
            <button class="vc-btn vc-btn-sm" :class="{ 'vc-btn-on': tagsOpen }" @click="toggleTags"
                    title="Tags & rating">
              <ui-icon name="label" :size="22"></ui-icon>
            </button>
          </div>
        </div>
      </transition>

      <!-- ── Center play/pause button (visible when the player UI is open) ── -->
      <button v-show="phase === 'ready' && controlsVisible && !remote" class="vc-center" @click.stop="togglePlay"
              :title="isPlaying ? 'Pause' : 'Play'" :aria-label="isPlaying ? 'Pause' : 'Play'">
        <ui-icon :name="isPlaying ? 'pause' : 'play'" :size="72"></ui-icon>
      </button>

      <!-- ── Volume % HUD (scrollwheel / slider) ─────────────────── -->
      <transition name="center-pop">
        <div v-if="volHud" class="vol-hud">
          <ui-icon :name="muted || playerVolume === 0 ? 'volumeOff' : 'volumeUp'" :size="22"></ui-icon>
          <span>{{ Math.round((muted ? 0 : playerVolume) * 100) }}%</span>
        </div>
      </transition>

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
        <button v-if="remote" class="btn" @click="watchHere">
          <ui-icon name="close" :size="20"></ui-icon> Disconnect and play locally
        </button>
      </div>

      <!-- ── Custom control bar (UI only) ──────────────────────── -->
      <div v-show="phase === 'ready'" class="vcontrols"
           :class="{ 'vcontrols-hidden': !controlsVisible }" @click.stop>

        <div class="vc-seek-row">
          <span class="vc-time">{{ fmt(currentTime) }}</span>
          <input class="vc-seek" type="range" min="0" :max="displayDuration || 0" step="0.1"
                 data-tv-step="10" data-tv-down="[data-tv-id='play']"
                 :value="currentTime" :disabled="!displayDuration" :style="seekStyle()"
                 @input="seekInput" @change="seekCommit" aria-label="Seek">
          <span class="vc-time vc-time-dur">{{ fmt(displayDuration) }}</span>
        </div>

        <div class="vc-btn-row">
          <div class="vc-group">
            <button class="vc-btn" :disabled="!prevVideo" @click="goPrev" title="Previous video">
              <ui-icon name="skipPrev" :size="26"></ui-icon>
            </button>
            <!-- TV mode has no click-to-toggle surface, so the transport needs
                 its own play/pause between prev and next -->
            <button v-if="tvMode" class="vc-btn" data-tv-id="play" @click="togglePlay"
                    :title="isPlaying ? 'Pause' : 'Play'" :aria-label="isPlaying ? 'Pause' : 'Play'">
              <ui-icon :name="isPlaying ? 'pause' : 'play'" :size="28"></ui-icon>
            </button>
            <button class="vc-btn" :disabled="!nextVideo" @click="goNext" title="Next video">
              <ui-icon name="skipNext" :size="26"></ui-icon>
            </button>
            <div class="vc-vol">
              <!-- data-tv-axis="y": in TV mode ↑/↓ change the volume and ←/→
                   keep moving along the control bar instead of snagging here -->
              <input class="vc-vol-slider" type="range" min="0" max="1" step="0.01"
                     data-tv-step="0.05" data-tv-axis="y"
                     :value="muted ? 0 : playerVolume" :style="volStyle()"
                     @input="onVolSlider" aria-label="Volume" title="Volume (↑/↓)">
              <button class="vc-btn" @click="toggleMute" :title="muted ? 'Unmute' : 'Mute'">
                <ui-icon :name="muted ? 'volumeOff' : 'volumeUp'" :size="26"></ui-icon>
              </button>
            </div>
          </div>

          <div class="vc-group">
            <button class="vc-btn" @click="qualityOpen = !qualityOpen" title="Playback quality">
              <ui-icon name="tune" :size="24"></ui-icon>
            </button>
            <button v-if="!remote" class="vc-btn" :class="{ 'vc-btn-on': loopOn }" @click="toggleLoop"
                    :title="loopOn ? 'Loop on — tap to stop looping' : 'Loop this video'">
              <ui-icon name="loop" :size="24"></ui-icon>
            </button>
            <button v-if="!remote && isTouchDevice && isFullscreen" class="vc-btn"
                    :class="{ 'vc-btn-on': landscape }" @click="toggleOrientation"
                    :title="landscape ? 'Switch to portrait' : 'Switch to landscape'">
              <ui-icon name="screenRotation" :size="24"></ui-icon>
            </button>
            <button class="vc-btn" @click="toggleFullscreen" title="Fullscreen">
              <ui-icon name="fullscreen" :size="26"></ui-icon>
            </button>
          </div>
        </div>
      </div>

      <!-- ── Quality menu (fixed, opens from the control bar, scrollable) -->
      <div v-if="qualityOpen" class="quality-backdrop" @click="qualityOpen = false"></div>
      <div v-if="qualityOpen" class="vc-quality">
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

      <!-- ── Tagging overlay: fullscreen = narrow right-side column, ────
           covering as little of the video as possible ────────────────── -->
      <div v-if="tagsOpen && isFullscreen" class="tag-fs">
        <tag-panel :all-tags="allTags" :selected="videoTagIds" :rating="videoRating"
                   :loading="tagsLoading"
                   @toggle-tag="toggleTag" @set-rating="setRating"
                   @create-tag="createTag" @close="tagsOpen = false"></tag-panel>
      </div>
    </div>

    <!-- ── Tagging overlay: not fullscreen = panel below the video ────── -->
    <div v-if="tagsOpen && !isFullscreen" class="tag-below">
      <tag-panel :all-tags="allTags" :selected="videoTagIds" :rating="videoRating"
                 :loading="tagsLoading"
                 @toggle-tag="toggleTag" @set-rating="setRating"
                 @create-tag="createTag" @close="tagsOpen = false"></tag-panel>
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
        <div v-else-if="s.showTranscodeInfo && remote" class="buffer-done">
          <ui-icon name="cast" :size="18"></ui-icon> {{ activeConfig }}
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

    <!-- ── Cast-to-receiver modal ───────────────────────────────────── -->
    <cast-panel v-if="castOpen" :path="path" :file-name="displayName" :folder="folder"
                @close="castOpen = false"></cast-panel>

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
