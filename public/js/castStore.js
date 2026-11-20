/* ─── CastStore: global "casting to a Castor receiver" session ─────────────
 *
 * Casting is a session-level mode, not a per-video action: once you start
 * casting, the app becomes a remote control for the receiver. Opening any
 * video auto-casts it to the receiver (see VideoPlayer.startRemote) and the
 * transport controls (play/pause, seek, ±10 s, volume, fullscreen, quality)
 * are forwarded to the receiver instead of driving local playback.
 *
 * The active session is persisted to localStorage so it survives navigation
 * and page reloads; on load we resume polling the receiver's state.
 */
/* global Vue, Utils, SettingsStore */

const CastStore = (function () {
  const KEY = 'srvfiles-cast';

  const state = Vue.reactive({
    active: false,
    receiver: null,     // { id, url, name, mode, pin }
    path: '',           // server path of the video currently cast
    name: '',           // display name
    folder: '',         // folder of the video (for auto-next)
    backend: '',        // 'hls-transcode' | 'direct-file' | 'local-file'
    playback: null,     // Castor PlaybackState { status, position, duration, volume, title, error }
    online: true,
    error: null,
    busy: false,
  });

  let timer = null;
  let inFlight = false;     // avoid overlapping state polls on a slow receiver
  let wasPlaying = false;   // receiver was playing/paused since the last idle
  let endHandled = false;   // idle/stopped already processed (auto-next / manual stop)

  // ── Persistence ────────────────────────────────────────────────────────
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        active: state.active,
        receiver: state.receiver,
        path: state.path,
        name: state.name,
        folder: state.folder,
        backend: state.backend,
      }));
    } catch { /* storage unavailable */ }
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* ignore */ }
    if (!saved || !saved.active || !saved.receiver || !saved.receiver.url) return;
    state.active = true;
    state.receiver = saved.receiver;
    state.path = saved.path || '';
    state.name = saved.name || '';
    state.folder = saved.folder || '';
    state.backend = saved.backend || '';
  }

  // ── Receiver addressing (mirrors server-side resolveReceiver) ──────────
  function receiverFields() {
    const r = state.receiver || {};
    const fields = { mode: r.mode || 'remote' };
    if (r.id != null && r.id !== '') fields.receiverId = r.id;
    else if (r.url) fields.receiverUrl = r.url;
    if (r.name) fields.receiverName = r.name;
    if (r.pin) fields.pin = r.pin;
    return fields;
  }

  function queryString(fields) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    }
    return p.toString();
  }

  function folderOf(p) {
    return String(p || '').replace(/[\\/][^\\/]*$/, '');
  }

  // ── Polling ────────────────────────────────────────────────────────────
  function startPolling() {
    if (timer || !state.active) return;
    timer = setInterval(poll, 2000);
    poll();
  }

  function stopPolling() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function poll() {
    if (!state.active || inFlight) return;
    inFlight = true;
    try {
      const data = await Utils.api('/api/castor/state?' + queryString(receiverFields()));
      state.online = true;
      state.error = null;
      state.playback = data && data.state ? data.state : data;
      maybeAutoNext();
    } catch (e) {
      state.online = false;
      state.error = e.message;
    } finally {
      inFlight = false;
    }
  }

  /**
   * Receiver-side auto-advance: the HLS/direct modules have no sibling
   * playlist, so when the item ends (status → stopped) we cast the next
   * video of the same folder ourselves, honouring the local autoNext setting.
   */
  function maybeAutoNext() {
    const pb = state.playback;
    if (!pb) return;
    const status = pb.status;
    if (status === 'playing' || status === 'paused' || status === 'loading') {
      wasPlaying = true;
      endHandled = false;
      return;
    }
    if ((status === 'stopped' || status === 'idle') && wasPlaying && !endHandled) {
      endHandled = true;
      wasPlaying = false;
      if (SettingsStore.settings.autoNext) autoAdvance();
    }
  }

  async function autoAdvance() {
    const folder = state.folder || folderOf(state.path);
    if (!folder) return;
    const from = state.path;
    try {
      const data = await Utils.api('/api/browse?path=' + encodeURIComponent(folder));
      const videos = (data.contents || []).filter(c => c.isVideo);
      const i = videos.findIndex(v => v.path === from);
      if (i < 0 || i >= videos.length - 1) return;
      const next = videos[i + 1];
      await cast({
        path: next.path,
        name: next.name,
        folder,
        receiver: state.receiver,
      });
    } catch { /* folder gone or unreachable — stop quietly */ }
  }

  // ── Actions ────────────────────────────────────────────────────────────
  /**
   * Cast a file to a receiver and make it the active session.
   * receiver: { id?, url, name, mode, pin? }
   */
  async function cast({ path, name, folder, receiver, mode }) {
    if (!receiver || (!receiver.url && (receiver.id == null || receiver.id === ''))) {
      throw new Error('No receiver selected');
    }
    const modeVal = mode || receiver.mode || 'remote';
    const s = SettingsStore.settings;
    const body = {
      path,
      mode: modeVal,
      receiverId: receiver.id != null && receiver.id !== '' ? receiver.id : undefined,
      receiverUrl: receiver.id != null && receiver.id !== '' ? undefined : receiver.url,
      receiverName: receiver.name,
      res: s.videoResolution,
      cq: s.videoQuality,
      speed: s.encodeSpeed,
      codec: s.videoCodec === 'auto' ? 'h264' : s.videoCodec,
    };
    const res = await Utils.api('/api/castor/cast', { method: 'POST', body });

    state.receiver = {
      id: receiver.id != null && receiver.id !== '' ? receiver.id : null,
      url: receiver.url,
      name: receiver.name || (res.receiver && res.receiver.name) || receiver.url,
      mode: modeVal,
      pin: receiver.pin || '',
    };
    state.path = path;
    state.name = name || String(path).split(/[\\/]/).pop();
    state.folder = folder || folderOf(path);
    state.backend = res.backend || '';
    state.playback = res.state || null;
    state.online = true;
    state.error = null;
    state.active = true;
    wasPlaying = false;   // wait for real playback before arming auto-next
    endHandled = true;    // ignore a stale 'stopped' from the previous item
    persist();
    startPolling();
    return res;
  }

  /** POST a transport command to the active receiver. */
  async function command(cmd, body) {
    if (!state.active) throw new Error('Not casting');
    state.busy = true;
    try {
      const res = await Utils.api('/api/castor/command', {
        method: 'POST',
        body: Object.assign({ command: cmd, body: body || {} }, receiverFields()),
      });
      if (res && res.state) state.playback = res.state;
      state.online = true;
      state.error = null;
      return res;
    } catch (e) {
      state.error = e.message;
      if (/unreachable/i.test(e.message)) state.online = false;
      throw e;
    } finally {
      state.busy = false;
    }
  }

  function play() { return command('play'); }
  function pause() { return command('pause'); }
  function toggle() { return command('toggle'); }
  function seek(position) { return command('seek', { position }); }
  function seekRelative(delta) { return command('seek-relative', { delta }); }
  function setVolume(volume) { return command('volume', { volume }); }
  function fullscreen() { return command('fullscreen'); }

  /** Stop receiver playback without leaving the casting session. */
  async function stop() {
    endHandled = true;      // an explicit stop must not trigger auto-next
    wasPlaying = false;
    return command('stop');
  }

  /**
   * Leave casting mode. By default the receiver is stopped too (otherwise the
   * TV keeps playing while the user watches locally). Returns the receiver
   * position so the caller can resume local playback where it left off.
   */
  async function disconnect({ stopReceiver = true } = {}) {
    const position = (state.playback && state.playback.position) || 0;
    const path = state.path;
    if (stopReceiver && state.active) {
      try { await command('stop'); } catch { /* receiver gone — fine */ }
    }
    stopPolling();
    state.active = false;
    state.receiver = null;
    state.path = '';
    state.name = '';
    state.folder = '';
    state.backend = '';
    state.playback = null;
    state.error = null;
    state.online = true;
    wasPlaying = false;
    endHandled = false;
    persist();
    return { path, position };
  }

  restore();
  if (state.active) startPolling();

  return {
    state,
    cast,
    command,
    play,
    pause,
    toggle,
    seek,
    seekRelative,
    setVolume,
    fullscreen,
    stop,
    disconnect,
    startPolling,
    stopPolling,
    /** True when a session is active and the given path is already cast. */
    isCastingPath(path) { return state.active && state.path === path; },
  };
})();