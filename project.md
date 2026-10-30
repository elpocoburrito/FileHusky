# SrvFiles — project notes

Self-hosted file server for personal video libraries. Node.js + Express
(`server.js`), no build step: plain ES5-style JS with Vue 3 (petite-vue-style
global build) rendered from inline template strings in
`public/js/components/*.js`. Styling in `public/css/style.css` (custom
properties, dark/light themes). Docker support via `docker-compose.yml`
(host port 3003 → container 3000, host filesystem mounted at `/host`).

## Architecture

- `server.js` — Express API:
  - `/api/browse` — directory listing (isVideo/isImage flags)
  - `/api/video/metadata`, `/api/video/stream/start|status` — ffprobe metadata
    and on-demand HLS transcode sessions (NVENC h264/hevc, segment caching)
  - `/api/video/raw` — original file (direct play + download)
  - `/api/video/tags`, `/api/tags`, `/api/groups` — SQLite-backed tagging
    (groups → tags, exclusive within group; 1–5 star rating per video)
  - `/api/download/zip`, `DELETE /api/folder` — folder ZIP download / delete
  - `safePath()` guards every path param (no traversal, no roots)
- `public/js/app.js` — hash router (browse / video / tags pages)
- `public/js/components/` — Vue components:
  - `FileManager.js` — list/grid browser, search/sort, folder ⋮ menu
  - `VideoPlayer.js` — playback page (see below)
  - `TagPanel.js` — tags+rating editor inside the player
  - `TagManager.js` — full tag management page
  - `SettingsPanel.js` — persisted settings (SettingsStore, localStorage)
- `public/js/icons.js` — inline SVG icon registry (legacy 0 0 24 24
  Material paths), rendered by the `<ui-icon>` component
- Transcoding: HLS via hls.js; direct play for browser-compatible originals;
  HEVC auto-selected only when `MediaSource.isTypeSupported` says OK.

## Video player (VideoPlayer.js)

- Custom UI overlay: bottom control bar (seek row + prev/next/volume |
  quality/loop/fullscreen), top bar (title, wall clock, download / open
  external / tags), big center play/pause button. All three appear/hide
  together: tap on touch toggles the UI (`togglePlayerUi`); on desktop,
  click = play/pause, double-click = fullscreen, mousemove reveals.
  Touch vs mouse decided by pointer type captured at `pointerdown`
  (`_downPointerType`) — click events carry no pointerType.
- Auto-hide after 3 s while playing (`scheduleHide`); paused always shows.
- Resume positions in localStorage `srvfiles-resume:<path>` (throttled 3 s).
- Quality menu (resolution/quality/speed/codec) restarts the stream at the
  same position (`changePlayback` → `pendingSeek`).
- Tagging overlay: right-side column in fullscreen (`.tag-fs`), card below
  the video otherwise; Escape closes.
- External player modal: raw URL copy + `vlc://` / `nplayer-` links.
- Orientation button (bottom bar, only when fullscreen && touch device):
  `screen.orientation.lock()` landscape/portrait toggle; iOS fallback cycles
  fullscreen so OS auto-rotate can engage. Wall clock updates every 15 s.
- Keyboard: space play/pause, ←/→ ±10 s, m mute, f fullscreen, l loop,
  n/p next/prev, Escape closes menus.

## Conventions

- Commit style: short imperative subject + bullet body.
- `project.md` is append-only: each feature gets a `----`-delimited entry.

----

## 2026-09-25 — Player UI overhaul (touch-first)

- Touch tap on the video now opens/dismisses the player UI instead of
  toggling playback (previously every tap played/paused because
  `lastPointerType` defaulted to `'mouse'` and was never set to `'touch'`).
- Replaced the center flash-burst with a persistent center play/pause
  button (`vc-center`) shown whenever the UI is visible; removed
  `centerIcon`/`pulseCenterIcon` and the old `center-pop` usage for it
  (the vol-hud keeps a `center-pop` transition, keyframes now use
  `translateX(-50%)`).
- Added overlay top bar (`vc-top`): video title, wall-clock HH:MM
  (`wallClock`, 15 s ticker), and the download / open-external / tags
  buttons moved up from the bottom bar (bottom bar keeps prev/next/volume
  + quality/loop/fullscreen).
- New orientation toggle button in the bottom bar, visible only in
  fullscreen on touch devices; uses `screen.orientation.lock()` with an
  iOS fullscreen-cycle fallback. New `screenRotation` icon in icons.js.
- Touch/mouse distinction now from `_downPointerType` captured in
  `onPointerDown` (new `@pointerdown` binding on `.video-area`); desktop
  click/double-click behavior unchanged.
- Cleanup: `catch (_) {}` → `catch {}`, unused hls error callback param
  renamed `_event` (lint hygiene).

----

## 2026-09-25 — Home menu (favorite folders)

- New landing page: the root URL (no hash) and `#/home` open the home
  menu instead of the file browser. The house icon in the browse header
  now routes to home (`$router.push({name:'home'})`) instead of `/`.
- Server: `GET/POST/DELETE /api/home/folders` — favorites persisted in
  `data/home.json` (defaults `/mnt` + `/media`, written on
  first GET). POST validates the path via `safePath` + isDirectory
  (so traversal/nonexistent paths are refused) and stores the
  client-facing path (`fromHostPath`), which stays correct under the
  Docker HOST_ROOT mount. DELETE is idempotent.
- New component `public/js/components/Home.js` (`home-page`): reuses the
  file-browser list rows (.file-row/.file-icon/.row-menu-btn) with the
  full path as the subtitle; inline add form (validated server-side);
  remove button per row (no confirm, per user's choice); header shows
  the home icon in an active/disabled state plus tags + settings.
- Router changes in app.js: default route is now home; `#/` also maps
  home; `toHash` emits `#/home`.
- CSS: `.home-head`, `.home-add` (+input), `.home-list .file-sub`
  (ui-monospace path), `.header-home.current` active state.
- Smoke-tested all three endpoints against a live server on :3457.

----

## 2026-10-08 — Cast to a Castor receiver (LAN casting)

A LAN receiver app plays a URL or
file path sent to its HTTP API (`POST /api/cast {module,target}`, port 8642).
SrvFiles can now cast the video it is showing — or any video row — to a
receiver on the LAN, in two modes: **local file** (receiver on the same host
as this server: send the path) and **remote/transcode** (receiver on another
device: send an HTTP URL served by this server).

- **Discovery**: new `castor-mdns.js` — a zero-dependency DNS-SD browser for
  `_castor._tcp` (what Castor advertises). Two gotchas encoded in it:
  - the query is sent **per non-internal IPv4 interface** (`setMulticastInterface`),
    because the OS default multicast egress can be a VPN/tunnel interface that
    never sees LAN multicast;
  - responses are deduped by instance name + port, preferring LAN-looking
    addresses, because a receiver co-located with docker bridges answers on
    every interface (avahi) and the bridge IPs aren't reachable from a phone.
  Legacy-unicast queries (ephemeral source port) are used, so replies come back
  unicast and no multicast group membership is needed to receive them.
- **Receiver store**: `data/castor-receivers.json` (`{id,url,name,mode,pin}`),
  written on first change; saved receivers are probed via `GET /api/info` for
  online/state. `pin` is forwarded as `X-Castor-Pin` for paired receivers.
- **New endpoints**:
  - `GET /api/castor/receivers` → `{discovered, saved}` (mDNS browse cached 5 s)
  - `POST /api/castor/receivers` → add/update (probes the URL first; 502 if no
    receiver answers); `DELETE /api/castor/receivers?id=`
  - `POST /api/castor/cast` → `{path, receiverId|receiverUrl, mode}`; mode
    `local` sends Castor's `local` module the host path (client-facing paths
    already match the host filesystem — HOST_ROOT is stripped), mode `remote`
    picks the transport: probe-first via `ffprobe` — browser-compatible
    container+codecs (mp4/m4v/webm/mov with h264/vp8/vp9/av1 + aac/mp3/opus/
    vorbis/flac) stream the original file as a `direct` URL, everything else
    starts an HLS session and sends the playlist URL.
  - `POST /api/castor/command` (allow-listed transport passthrough) and
    `GET /api/castor/state` so the UI can show live state / stop playback.
- **Cast-friendly URLs**: `GET /api/video/cast/<name>` serves the original file
  (Range-capable) and `…/<name>.m3u8` serves a session playlist. The segment
  URIs in that playlist are stamped with `?session=<id>` because hls.js resolves
  relative playlist URIs *without* the playlist URL's query string — the same
  route serves `segment-N.m4s` / `init.mp4` for a running session. The pretty
  last path segment gives the receiver a sensible title.
- `startStreamSession(sp, query)` extracted from `/api/video/stream/start` and
  `serveStreamSegment` / `serveStreamInit` extracted from the segment routes so
  the cast flow reuses the exact same transcoding code paths.
- **Frontend**: new `CastPanel.js` (`cast-panel`) — receiver picker modal with
  discovered + saved receivers, per-receiver mode select (Local file /
  Transcode), add-manual form, save/remove, cast + stop. Opened from a
  **cast button in the player's top bar** (`VideoPlayer.js`) and from a
  **“Cast to receiver…” entry in the video row menu** (list + grid, FileManager
  — video rows now get a ⋮ menu too). `cast` icon added to `icons.js`; styles
  under “Cast-to-receiver modal” in `style.css` (reuses `.modal-root/.modal-card`).
- **Docker note**: discovery needs LAN multicast, which a bridge network does
  not forward — `docker-compose.yml` documents `network_mode: host` +
  `PORT: 3003` as the way to enable it; manual receiver entry works either way.
- Also cleaned up when touched: `catch (_) {}` → `catch {}`, unused `req`
  params renamed `_req`, removed dead `sanitizePath`, and `a && b()` →
  `if (a) b()` in the segment pipeline (linter blockers).
- Verified against a mock receiver and a live receiver: remote mp4 → raw URL played in-window
  (position advancing), remote mkv → HLS session delivered playlist/init/
  segments and played, local mode handed over the host path. Discovery found
  the real receiver as a single deduped LAN entry.
- `README.md` documents the feature: a bullet in the feature list and an
  “API (casting to a Castor receiver)” section (endpoints + the bridge-network
  discovery caveat).

----

## Fix: container crashed with `Cannot find module './castor-mdns'`

- Symptom: `docker`/`node:22` container exited at boot with
  `Error: Cannot find module './castor-mdns'` at `/app/server.js:1121`.
- Cause: `castor-mdns.js` was added as a local module (`require('./castor-mdns')`)
  but the `Dockerfile` only copied `server.js` and `public/`, so the file never
  landed in `/app`. It is also untracked in git at the time of writing.
- Fix: added `COPY castor-mdns.js ./` to the `Dockerfile` before the `public`
  copy. Rebuild with `docker compose build --no-cache && docker compose up -d`.
- Note: any future top-level `require('./x')` module must be added to the
  `Dockerfile` copy list (and committed) or the image will fail the same way.

----

## Feature: cast remote mode (the client becomes a remote control)

Casting is now a **session**, not a per-video action. Decisions taken with the
user (interview): remote-control panel UI; session survives navigation *and*
reload; opening a new video auto-casts it; controls forwarded = play/pause,
seek/±10 s, volume/mute, next/previous, fullscreen, quality; auto-next mirrored
from the local `autoNext` setting.

- **New `public/js/castStore.js`** — global reactive `CastStore.state`
  `{ active, receiver, path, name, folder, backend, playback, online, error }`.
  API: `cast()`, `command()`, `play/pause/toggle/seek/seekRelative/setVolume/`
  `fullscreen/stop`, `disconnect()`, `startPolling/stopPolling`,
  `isCastingPath()`. Polls `GET /api/castor/state` every 2 s (overlap-guarded),
  persists `{active,receiver,path,name,folder,backend}` to localStorage key
  `srvfiles-cast`, and restores + resumes polling on load. Auto-next: when the
  receiver reports `stopped` after playing, casts the next video of `folder`
  (fetched via `/api/browse`) if `SettingsStore.settings.autoNext`. Guards
  (`wasPlaying`/`endHandled`) prevent auto-next from firing on a stale
  `stopped` right after a cast or on a manual Stop.
- **`VideoPlayer.js`** — new `remote` state. `start()` branches: if
  `CastStore.state.active` it calls `startRemote()` instead of creating a
  transcode session; `startRemote()` auto-casts when `state.path !== path`
  (otherwise just mirrors), hides the `<video>` (`v-show="!remote"`) and shows
  a `.remote-panel`: receiver badge, live title/status, large
  rewind/play-pause/forward/stop buttons, and “Disconnect & watch here”.
  Controls are forwarded while `remote`: `togglePlay`, `seekCommit`, arrow
  keys (±10 s), volume slider/scroll/mute, `toggleFullscreen` (receiver),
  `setQuality` (re-casts with the new transcode settings). Seek bar now uses a
  computed `displayDuration` (= receiver duration while casting). A watcher on
  `cast.playback` mirrors `status/position/volume`; a watcher on `cast.active`
  enters remote when a cast starts from the CastPanel and resumes **local**
  playback at the receiver position when the session ends (`watchHere()`).
  Next/Previous work unchanged: opening the sibling triggers auto-cast.
  Loop and the touch orientation button are hidden in remote mode; the centre
  play button is hidden too (the panel has its own).
- **`CastPanel.js`** — casting now goes through `CastStore.cast()` (adds
  `folder` prop, passed from `VideoPlayer` and `FileManager`) so the panel
  starts/updates the global session; `stop()` routes through `CastStore.stop()`
  when the row is the active receiver (so it doesn't trigger auto-next).
  Modal note explains that playback moves to the receiver.
- **`FileManager.js`** — passes the current folder into `cast-panel`;
  plays/casts remain unchanged (opening a video auto-casts because of the
  store).
- **`icons.js`** — added `stop`, `fastRewind`, `fastForward`.
- **`style.css`** — “Remote-control panel (casting mode)” block + compact
  variant for short screens (bottom padding keeps it clear of the control bar).
- **`index.html`** — loads `js/castStore.js` after `settings.js`.
- Server untouched: the existing `/api/castor/{cast,command,state}` endpoints
  already cover everything (commands include volume/fullscreen/seek-relative).
- **README** documents remote mode + the client store.

----

## 2026-10-30 — Mobile player input & auto-landscape fullscreen

Three mobile-only issues in the video player, all rooted in the tap target
being the `<video>` element rather than the whole playback surface:

- **Tap anywhere to toggle the UI.** The `@click` handler moved from the
  `<video>` to `.video-area` (the video now only keeps `@dblclick`), so a tap
  anywhere on the player surface opens/closes the overlay. `onVideoClick`
  ignores clicks whose target is inside `.vcontrols`, `.vc-top`, `.vc-center`,
  `.remote-panel`, `.tag-fs`, `.vc-quality`, `.quality-backdrop` or
  `.video-overlay` (menus/tag panels don't use `@click.stop`, so they're
  filtered by target instead of relying on propagation alone). Touch detection
  falls back to `isTouchDevice()` when `_downPointerType` is empty, and
  `onPointerDown` no longer defaults an empty `pointerType` to `'mouse'`.
- **Hidden UI is inert.** The `.video-area` gets a `vc-ui-hidden` class while
  `!controlsVisible`; `.vc-ui-hidden .vc-top` / `.vc-ui-hidden .vc-center`
  are `pointer-events: none` so no control captures a tap during the fade-out
  (the bottom bar already had `pointer-events: none` via `vcontrols-hidden`).
- **Auto-landscape fullscreen.** `onFullscreenChange()` now, on entering
  fullscreen on a touch device with a landscape video (`mediaIsLandscape()`,
  from `videoWidth/videoHeight` or the ffprobe metadata), calls
  `lockOrientation('landscape')`; `unlockOrientation()` releases the lock when
  fullscreen exits. The orientation button's `toggleOrientation` reuses the
  same `lockOrientation` helper (and keeps the iOS fullscreen-cycle fallback).
- No `server.js` changes; verified with `node --check` + pi-lens diagnostics.

----

## Fix: mobile taps were swallowed (player UI never opened)

The previous "tap the video to toggle the UI" fix was built on `click`, which
never fires reliably here. Two independent causes, both now removed:

1. **`index.html`'s double-tap zoom blocker** called `e.preventDefault()` on
   `touchend` for any tap within 300 ms of the previous one. Preventing the
   default on `touchend` suppresses the **synthesized click**, so every second
   quick tap (the natural rhythm when a tap appears to do nothing) was eaten —
   app-wide, not just in the player. It was redundant anyway: `touch-action:
   manipulation` on `html, body` already disables double-tap zoom. Only the
   `gesturestart` and two-finger `touchmove` pinch blockers remain.
2. **`click` on a `<video>`** is unreliable on mobile browsers even without
   that blocker.

The player surface now lags nothing to `click`:

- `@pointerdown` records `_down = {type, x, y, t, target}`; `@pointerup`
  (`onPointerUp`) treats it as a tap when the pointer did not move more than
  12 px, was held under 700 ms, and neither the start nor the end target is
  inside `.vcontrols / .vc-top / .vc-center / .remote-panel / .tag-fs /
  .vc-quality / .quality-backdrop / .video-overlay` (`isControlTarget()`).
  `@pointercancel` (scroll/gesture takeover) discards the pending tap.
- Touch tap → `togglePlayerUi()`. Mouse keeps desktop conventions: single
  click → play/pause (260 ms deferred), double click → fullscreen. `@click`
  and `@dblclick` bindings were removed from `.video-area` / `<video>`, and
  `onVideoClick` / `onVideoDblClick` are gone.
- Hiding is centralised in `hideControls()` (clears the timer and closes the
  quality menu) — used by `togglePlayerUi`, `scheduleHide` and the
  mouse-leave timer. `.vc-ui-hidden` (pointer-events: none on `.vc-top` /
  `.vc-center`) keeps hidden controls inert; `vcontrols-hidden` already did.

**Auto-landscape fullscreen** is now shared state, not one handler:
`syncFullscreenState(isFs)` drives `isFullscreen` + `tryAutoLandscape()`, which
locks `landscape` when the device is touch and `mediaIsLandscape()` (from
`videoWidth/Height`, falling back to ffprobe metadata), retrying once after
400 ms because fullscreen may still be settling; leaving fullscreen calls
`unlockOrientation()`. `onFullscreenChange` (document) and the iOS
`webkitbeginfullscreen` / `webkitendfullscreen` events on the `<video>` both
route into it, so iOS native video fullscreen is covered too (iOS has no
orientation-lock API, so there it remains best-effort).
