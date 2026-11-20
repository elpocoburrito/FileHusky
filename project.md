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

----

## Fix: tap-through to revealed buttons; orientation on next video

Two follow-ups after taps started working again:

- **Invisible buttons were still activated.** Not a CSS problem — the hidden
  bars really are inert (`vcontrols-hidden` / `vc-ui-hidden`). It was an
  ordering race: the tap's `pointerup` *reveals* the UI, and the browser then
  dispatches the synthesized `click` at the same coordinates, which now lands
  on a button that did not exist a moment earlier (previously masked by the
  removed `touchend` blocker). `onPointerUp` therefore arms
  `_suppressClickUntil = now + 500 ms` before toggling, and a
  `@click.capture="onCaptureClick"` on `.video-area` swallows that one click
  (`preventDefault` + `stopPropagation`, which also stops the button's own
  handler). `onPointerDown` clears the flag so a stale window can never eat a
  later legitimate control click.
- **Fullscreen landscape was wrong for the next video.** `#/video` reuses the
  same `<video-player>` instance (the route element is not `:key`ed), so
  `isFullscreen` and the landscape lock survived a video change — a portrait
  video inheriting the previous video's landscape lock. Orientation is now
  re-applied whenever media dimensions become known (in the `loadedmetadata`
  handler when `isFullscreen`): `applyAutoOrientation()` locks landscape for
  landscape videos and calls `unlockOrientation()` for portrait ones, so a
  stale lock is released. `tryAutoLandscape()` was replaced by
  `applyAutoOrientation()` + `clearOrientationRetry()` (the retry timer is
  also cleared in `cleanup()`).

----

## Fix: UI re-appeared after a tap hid it (compatibility mouse events)

Symptom: with the UI visible, tapping empty video space hid it for a split
second and then it came straight back.

Cause: the surface was bound to **`@mousemove`**, and mobile browsers synthesise
compatibility **mouse** events (`mousemove`) immediately after a tap — now that
the `touchend` preventDefault blocker is gone, nothing suppressed them. That
`mousemove` ran `onPointerMove`, whose `if (e.pointerType && ...)` guard passed
because a plain `MouseEvent` has **no** `pointerType`, so it was treated as a
mouse and called `showControls()` — re-revealing the UI the same tap had hidden.

- The surface now listens to pointer events only: `@pointermove` /
  `@pointerleave` replace `@mousemove` / `@mouseleave`.
- New `pointerTypeOf(e)` resolves the type as `e.pointerType ||
  (isTouchDevice() ? 'touch' : 'mouse')`, so an absent `pointerType` is never
  read as a mouse. Used by `onPointerMove`, `onMouseLeave` and `onPointerDown`.
- `lastPointerType` became dead state (write-only) and was removed.

----

## Fix: portrait flash on the first "next video" in fullscreen

Symptom: in fullscreen landscape mode, the *first* "play next" briefly flipped
to portrait and then back to landscape; later transitions were fine.

Cause: swapping the media source makes the browser drop the orientation lock,
and the only thing that re-took it was the single retry scheduled **400 ms**
after `applyAutoOrientation()` — hence a visible portrait hop while fullscreen
was being re-established. The one-off nature came from that retry window: a
lock taken during the very first transition left the session locked, so later
swaps did not show it. `applyAutoOrientation()` could also *release* the lock
whenever dimensions were momentarily unknown, which is exactly the state during
a media swap.

- `mediaDimensions()` returns the video's real pixel size (or `null` when not
  reliably known). `applyAutoOrientation()` keeps the current lock when the
  dimensions are unknown and re-checks after 250 ms instead of unlocking —
  a video change must never flash the screen to portrait.
- `holdLandscape()` re-asserts the lock every ~120 ms for 1.5 s after it is
  applied, so a lock dropped by the swap is retaken almost immediately instead
  of once after 400 ms. It stops as soon as fullscreen ends or the wanted
  orientation changes.
- `start()` re-asserts (and re-holds) the lock immediately after `cleanup()` when
  fullscreen, touch, and landscape was already wanted, rather than waiting for
  the new video's `loadedmetadata`.
- `_wantOrientation` tracks the intended lock inside `lockOrientation()` /
  `unlockOrientation()` (which also cancels the hold), so the hold never fights
  the video's own orientation.
- A manual choice from the orientation button sets `_manualOrientation`, which
  suppresses auto-orientation for that video; the `path` watcher clears it when
  moving to the next video, so a new video is auto-oriented again.

----

## Fix: Firefox Android portrait flash on the first "next video"

Platform: **Firefox for Android**, app's own
fullscreen overlay (a div, not the native player), and the *whole UI* rotates
to portrait and back. That rules out several earlier guesses:

- `ScreenOrientation.lock()` did not exist in Firefox until **144**
  (2025-10-14) and is still only partially supported, so on older Fenix the
  whole orientation-lock path is inert (`lockOrientation()` returns false and
  `_wantOrientation` stays null, so `holdLandscape()` never runs). The earlier
  hold/retry work cannot help there, which is why it changed nothing.
- Firefox for Android does its own fullscreen/orientation juggling around the
  `<video>` element.

Real culprit found in our code: `cleanup()` blanked the media on every
`start()`

    player.removeAttribute('src');
    player.load();

so between videos the fullscreen element held a **sourceless `<video>`** while
the metadata request and transcode session were pending. That is exactly when
Firefox re-evaluated and flipped to portrait, flipping back once the next
source attached.

- `cleanup(keepMedia)` skips the blanking when the caller is about to attach a
  new source. `start()` now calls `cleanup(true)`, so the last frame stays
  attached across the swap (also removes the black flash between videos).
- Full teardown is unchanged for the cases that really unload: `beforeUnmount`,
  `startRemote()` (casting hides the video) and the fatal-error path.

Caveat recorded for later: on Firefox < 144 the automatic landscape rotation
cannot be driven by `screen.orientation.lock()` at all — whatever landscape is
seen there is Firefox's own fullscreen behaviour, so the rule is "do not
disturb it" rather than "force it".

## 2026-11-12 — TV mode (remotes, controllers, keyboard-only)

A pointer-free navigation mode for watching on a TV: toggled by a TV icon in
every page header (`tv-toggle`, right before the settings button) and picked
up on the next load from `SettingsStore.settings.tvMode` (new default `false`).

- **New `public/js/tv.js`** — a `TvMode` store (reactive `state.enabled`,
  mirrored from `SettingsStore.settings.tvMode`, so the icon, a settings reset
  and a direct write all converge) plus the navigation engine, exposed as
  `window.TvMode` like the other stores. Loaded right after `settings.js` so
  components can use `<tv-toggle>`.
- **Keys** (all handled in one capture-phase `keydown` listener on `document`
  that `preventDefault()`s and `stopImmediatePropagation()`s what it owns, so
  the player's own hotkeys never see them):
  - ←/→/↑/↓ move focus to the nearest focusable element in that direction
  - Enter/Space activate the focused element; Backspace goes back
  - Escape is treated as Backspace (same key on most remotes)
  - text fields keep every key (a keyboard can type, a remote cannot) —
    Escape leaves the field
- **Spatial navigation** (`moveFocus`): candidates in the same direction are
  scored by primary distance, preferring those whose perpendicular projection
  overlaps the current element — a file list therefore walks row by row
  instead of jumping to a closer button beside the row. Off-axis candidates
  are penalised `secondary * 2`; at the end of a list the direction wraps.
- **Layers**: `.modal-root`, `.settings-root`, `.vc-quality`, `.row-menu`,
  `.tag-fs` are scopes — while one is open, arrows stay inside it. Backspace
  first re-dispatches Escape on the focused element so the app's existing
  Escape handlers close dialogs/menus; if the layer survives that (the
  settings sheet has no Escape handler) the layer's close button is clicked.
- **Back**: `tv-back` CustomEvent first (FileManager cancels it to go up a
  folder), then `history.back()`, then a hash fallback to `#/home` when a
  deep link had no history to pop. Before any of that, a Back press leaves
  fullscreen (a remote has a single back key) and closes the open layer, in
  that order: layer → fullscreen → folder up / history → home.
- **Ranges mean “adjust”**: on `input[type=range]` ←/→ step the value by
  `data-tv-step` instead of moving focus (seek = 10 s, volume = 5 %) and
  replay `input` + `change` so the existing preview/commit handlers run.
  ↑/↓ leave the slider — letting all four arrows adjust it would trap the
  focus there, since a remote has no Tab key. `<select>` keeps its native
  up/down behaviour.
- **Gamepads** (Gamepad API, polled with `requestAnimationFrame` only while
  the mode is on): D-pad buttons 12–15, left stick with a 0.6 deadzone, A
  (0) = select, B (1) = back; edge-triggered, then 350 ms delay + 140 ms
  repeat for held directions.
- **Focus ring**: a `.tv-focus` class (programmatic focus does not always
  match `:focus-visible`) maintained by `focusin`/`focusout`, styled as a
  3 px accent outline + soft halo, with a larger root font size.
- **`visibility` filter** ignores elements with no client rects, `display:
  none`, `opacity: 0`, or `pointer-events: none` on themselves *or any
  ancestor* — the player hides its bars on the `.vcontrols` / `.vc-top`
  container and `pointer-events` does not inherit, so walking the chain is
  what keeps invisible controls out of the ring.
- **VideoPlayer** — `scheduleHide()` returns early while TV mode is on (the
  overlay is the only thing a remote can navigate, so it must not disappear),
  a new document `focusin` handler (`onTvFocusIn`) reveals the controls when
  the ring enters `.video-area`, and a `phase` watcher parks the focus on
  `.vc-center` once playback is ready. Seek/volume sliders carry
  `data-tv-step`.
- **Focus on navigation** — `hashchange` → `TvMode.refocus()` waits (up to
  ~1.6 s) until `main` has focusable content, then focuses the preferred
  element (`.vc-center`, first file row/card, drive chip, else any button)
  without scrolling (the router already reset the scroll position).
- **CSS** (`style.css`, “TV mode” block): focus ring, filled state for the
  header toggle, and a `.tv-hint` toast that explains the controls for ~3 s
  when the mode is switched on or off.
- Gotcha fixed along the way: the engine's re-dispatched Escape must not be
  re-handled by itself — a `synthetic` flag guards `dispatchEscape()`.
- **New `.oxlintrc.json`** (repo root) declares the classic-script globals
  (`Utils`, `SettingsStore`, `CastStore`, `TvMode`, components, …) with
  `env.browser`. oxlint's `no-undeclared-variables` ignores `/* global */`
  comments, so every touched component file otherwise drowned in false
  “undeclared” errors.
- FileManager cleanup while touching it (lint hygiene): the shared scroll
  memory is now a module-level `SCROLL_MEM` (was
  `FileManager._scrollMem || (FileManager._scrollMem = {})`, an assignment in
  an expression), string concatenations became template literals, `!= null`
  was inverted, and `window.FileManager = FileManager` documents the global.
- `README.md` feature list documents TV mode.

## 2026-11-13 — Gallery views, TV follow-ups, thumbnails

Six requests in one pass: three display modes (with real thumbnails), TV-mode
hiding rules, TV focus fixes and player/settings polish.

- **Server: media flags + thumbnails**
  - `AUDIO_EXT` / `isAudio()` and an `isAudio` flag on `/api/browse` entries
    (audio files are now first-class rows: they show a music icon and are no
    longer mistaken for generic files).
  - `GET /api/thumb?path=…` → 480 px-wide JPEG, a frame ~2 s into videos
    (falls back to frame 0 for very short clips) or the scaled image for
    pictures, produced with `ffmpeg -vf scale='min(480,iw)':-2`.
  - Cached in `CACHE_DIR/thumbs` keyed by `sha1(path|mtimeMs|size|width)` —
    the client appends `&v=<mtime>` so the response is cacheable. Misses go
    through `withThumbSlot()` (2 concurrent ffmpeg runs, 20 s kill timer) and
    identical keys share one promise (`thumbJobs`). 404 when there is no
    still frame (audio/text) so the client can fall back to an icon; the
    temp file is written next to the final one and `rename`d into place.
- **Three display modes** — `settings.viewMode` is now
  `'list' | 'gallery' | 'gallery-lg'` (saved `'grid'` migrates to `'gallery'`).
  The toolbar button cycles list → gallery → large → list;
  `Settings → Layout` offers all three. The gallery replaces the old
  icon-only `file-grid`: `.gallery-grid` (auto-fill 168 px / 300 px) with
  `.gallery-card` → a 16:9 `.gallery-thumb` (identical shape for every item)
  plus name/subtitle, `img.thumb-img` lazy-loaded, `@error` → `noThumb[path]`
  so a missing preview swaps to the type icon. Folders, audio and other
  files keep the icon tile in the same shape.
- **TV mode hides non-media** — `visibleItems` filters to
  folders/videos/images/audio while TV mode is on (the toolbar's “Videos”
  chip becomes a non-interactive “Media” badge, since the filter is
  implicit), and the empty state says “No videos, images or audio in this
  folder”.
- **TV mode defaults to the big gallery** — enabling TV mode sets
  `viewMode = 'gallery-lg'`, leaving it restores `'list'` (in `TvMode.apply`).
- **Play/pause in the player's bottom bar** — new `vc-btn` between
  previous/next, rendered only in TV mode (`VideoPlayer.tvMode`), because
  there the video surface has no click-to-toggle. `hideControls()` now
  returns early in TV mode so the overlay (the only remote-navigable thing)
  can never disappear and strand the focus ring.
- **Getting back from the queue to the player** (was impossible): the player
  page keeps its video area sticky, so the queue scrolls *underneath* it and
  the geometry said “up” to rows that were painted over by the player.
  `isVisible()` now rejects candidates whose centre is covered by another
  element (`isCovered()` via `document.elementFromPoint`, skipped for
  off-screen targets which `scrollIntoView` will bring in), and
  `hit.contains(el)` keeps the player's own controls valid. The cover test
  also stops the sticky header from swallowing rows.
- **Empty folder starts on “Up one level”** — `PREFER` now asks for
  `main .up-btn` before `main .drive-chip`, and `main .gallery-card` joined
  `main .file-row` (so a drive shortcut is never the default).
- **Selects only take the arrows once opened** — settings pages were
  impossible to traverse because the focused `<select>` ate ↑/↓ natively.
  The native exemption is gone; `activate()` on a `<select>` now *arms* it
  (`armSelect`, dashed ring via `.tv-armed`), ↑/↓ then step `selectedIndex`
  and replay `input`/`change`, and Enter/Escape/←/→ (or losing focus)
  disarm it and let navigation continue. `onKeyDown` was split into
  `handleArmedSelect` / `handleDirection` / `isActivateKey` helpers.
- New icons: `musicNote`, `gridLarge`; `--audio` / `--audio-soft` theme vars
  and `.is-audio` classes (list rows, gallery tiles).
- Verified with two DOM harnesses (`/tmp`, not committed): 23 navigation
  checks plus 17 new ones (cover-aware navigation, empty-folder focus,
  gallery preference, select arming, TV default layout), `node --check` on
  every touched script, and a live-server smoke test of `/api/thumb`
  (video 480x270 JPEG, image 480 px wide, cached hit 0.9 ms, 404 for audio,
  400 for a directory/bad path) and the `isAudio` browse flag.

## Fix: blank file browser (dropped methods block)

Opening any folder from the home page rendered an empty page (only the page
background) instead of the browser.

- Cause: the gallery commit's `methods` patch never landed. That edit had been
  rejected earlier with "Edit without read" and only the template half was
  re-applied, so `itemClass`, `hasThumb`, `thumbUrl`, `onThumbError` and
  `cycleViewMode` (plus the `isAudio` branch of `itemIcon`) were missing while
  the template already called them. Vue threw
  `TypeError: itemClass is not a function` during the first render, which
  aborts the component render and leaves `#app` empty.
- Fix: the whole methods block is back in `FileManager.methods`, in the order
  the template uses it (type class → thumbnail helpers → view cycling).
- Verification this time is a **render test**, not just lint: a throwaway jsdom
  harness (`/tmp`, not committed) boots the real `index.html` markup with the
  real scripts concatenated into one eval (classic scripts share a lexical
  global scope; a separate eval per file would not) and a canned `fetch`.
  It asserts 25 things: the browse page renders, list/gallery/large layouts,
  thumbnails only for video+image, TV mode hiding non-media and defaulting to
  the large gallery, leaving TV mode restoring the list, the view-toggle and
  ⋮ row-menu click handlers, and the reported flow — home page → click a
  folder row → browse page renders with rows and zero console errors.
- Lesson recorded: a template that calls a method is not safe to ship on
  `node --check` + linter alone; the jsdom render pass catches missing
  members, wrong icons and broken `v-if` chains in one shot.

## 2026-11-14 — Live thumbnails (memory only) + long-press gallery actions

Two follow-ups: thumbnails should be rendered live for the folder being
viewed, and the gallery's ⋮ button kept stealing the TV focus.

- **Thumbnails: no disk cache.** `/api/thumb` now renders with ffmpeg into a
  buffer (`-f image2pipe -vcodec mjpeg pipe:1`) and keeps it in a **memory**
  map keyed by `path|mtimeMs|size` — nothing is written to disk, so a
  replaced file can never show a stale frame and the cache dir stays clean
  (verified: the old `srvfiles-cache/thumbs` directory is not recreated).
  The map is capped at 64 MB (oldest entry evicted first, one tile may never
  own more than a quarter of it) and reads re-insert the key so recently used
  tiles are evicted last. Responses are `Cache-Control: no-store` so the
  browser does not keep its own copy either; renders are still capped at two
  concurrent ffmpeg runs and identical in-flight requests share one job.
  The client URL dropped its `&v=<mtime>` cache-buster.
- **Gallery has no ⋮ button.** It sat at the card's top-right corner, which
  is between the rows in the grid, so every vertical move landed on it.
  Actions now come from the item itself:
  - tv.js opens the menu on a **long press** of Enter/Space (or a held **A**
    on a controller): it dispatches a `contextmenu` event on the focused
    element and the component opts in with `@contextmenu.prevent`; when no
    handler ran (`defaultPrevented === false`) it falls back to a normal
    activation, so holding a player button still works.
  - Activation therefore moved from **keydown to keyup** (`startPress` /
    `endPress` / `onKeyUp`, 600 ms `LONG_PRESS_MS`): a short press activates
    on release, a held one opens the menu and suppresses the release.
  - Gamepad A uses the same press/hold model (`padSelect`, `padPress`) and is
    no longer machine-gunned by the direction repeat loop; B is
    edge-triggered (`padBackHeld`).
  - Mouse right-click and touch long press work without any JS on desktop
    (native `contextmenu`); for iOS, where long press does not raise one,
    `onCardPointerDown` starts a 550 ms timer and the trailing click is
    swallowed by `onCardClick` (`_lpFired`). `.gallery-card` gets
    `-webkit-touch-callout: none` so the callout does not fight the menu.
  - List rows keep their ⋮ button (it is on the row edge, not between rows).
- CSS: `.row-menu-btn.grid` removed; `.gallery-cell .row-menu` now pins to
  the card's own corner (`top: 8px; right: 8px`).
- Gotcha hit while writing this: an HTML comment inside a component template
  that contained a **backtick** terminated the enclosing JS template literal
  and broke the file. Templates are backtick strings — never use one inside.
- Verified: `/api/thumb` cold 0.45 s → memory hit 0.85 ms, `no-store` header,
  404 for a non-media file, thumb dir not recreated; the jsdom render harness
  now has 32 checks (no ⋮ on cards, right-click and long-press open the
  actions menu, the click ending a long press does not navigate, list keeps
  its ⋮, thumbnail URLs carry no cache-buster); the tv.js harnesses have
  24 + 23 checks (activation on release, long press fires `contextmenu`,
  release after a long press does not activate, fallback activation when an
  element has no menu, selects still arm/disarm).

## Fix: the volume rocker swallowed ←/→ in the player

Moving along the player's control bar with a remote got stuck on the volume
slider: it sits *between* buttons (next → rocker → mute → quality…), and every
range input took ←/→ as "adjust" — so once the focus landed there, pressing
right changed the volume by 5 % and the focus never left.

- Sliders now own **only the axis they are drawn along**, declared with
  `data-tv-axis` (`x` by default, `y` for the volume rocker):
  - `x` → ←/→ change the value, ↑/↓ move on (the seek bar, unchanged)
  - `y` → ↑/↓ change the value, ←/→ move on (the volume rocker)
  `handleDirection()` asks `rangeOwnsKey()` instead of hard-coding the
  horizontal case; `stepRange()` accepts `up` as "+" for the vertical slider,
  so the mirror of the old behaviour is exact.
- `VideoPlayer` marks the slider `data-tv-axis="y"` (plus a `title` that says
  so). `onVolSlider` already raises the volume HUD on every change, so the
  level is visible while ↑/↓ are used — no extra focus-side code needed.
- Nothing else changes: the seek bar still steps 10 s with ←/→ and still lets
  ↑/↓ go, and both sliders keep their `data-tv-step`.
- Verified in the tv.js harness with a control bar (prev / play / next /
  rocker / mute): → lands on the rocker, a second → moves on **without**
  changing the value, ↑/↓ change it while keeping the focus, the value clamps
  at 0 % and 100 %, ← leaves the rocker, and the seek bar's ←/→ behaviour is
  untouched (that scenario already existed). 31 checks in that harness,
  24 in the other, 32 in the jsdom render pass.

## Fix: Up skipped the top of the queue and jumped to the player

With a long “Up next” list, pressing ↑ from the top-most *visible* queue row
jumped straight to the player's controls instead of walking up to the
“Preparing video” info card above the queue.

- Cause: the occlusion filter added with the earlier “back to the player” fix
  (`isCovered()` inside `isVisible()`) excluded every element painted over by
  the sticky video area. On the player page the queue scrolls *underneath*
  that sticky area, so every row above the top visible one — and the info card
  — counted as “covered” and dropped out of the candidate set. The nearest
  remaining target above was the player's own control bar.
- Fix: covered elements are candidates again. Instead of skipping them,
  `applyFocus()` now calls `revealFocus(el)` after `scrollIntoView`: it
  hit-tests the element's centre with `document.elementFromPoint` and, if
  something else is on top, scrolls the page until the element clears that
  overlay — a top overlay (header, sticky player) pushes the element below it,
  a bottom overlay (fixed bars) pulls it above, at most two passes, and
  off-screen targets are left to `scrollIntoView`. No component-specific
  knowledge is involved: the overlay is whatever actually sits on top.
- Result: ↑ now walks the whole queue row by row, each row scrolled out from
  under the player, then the info card, and only then the player controls —
  in both directions, and it also fixes rows hidden under the sticky header
  while browsing.
- Verification: the tv.js harness grew a scroll model (element rects shift
  with `scrollY`, elements marked sticky keep their viewport position) and
  now asserts 35 things, including: ↑ from the top visible row goes to the row
  above and NOT to the player, that row is scrolled below the player's bottom
  edge, further steps keep walking and revealing, after the last queue row
  comes the info card, and the step after that reaches the player controls.
  The other harness (24) and the jsdom render pass (32) are unchanged and
  still green.

## Fix: controller A did “up, then activate”

Pressing A on a gamepad moved the focus up one element before activating, so
it selected the item *above* the highlighted one.

- Cause: `GAMEPAD_ACTIONS` still mapped button 0 → `'select'` and 1 →
  `'back'` (left over from the first gamepad implementation). `pollGamepads()`
  feeds every action in that map through the direction/repeat loop, so A put
  `'select'` into the `active` set and `moveFocus('select')` ran.
  `geometry()` only adds a sign for `'down'`/`'right'` and treats anything
  else as the negative axis, so an unknown direction silently became **up**.
  B did the same thing (up) before going back.
- Fix: `GAMEPAD_ACTIONS` is the D-pad only (`12..15`); A and B are handled
  exclusively by `padSelect()` / `goBack()`. As a second layer, `moveFocus()`
  now returns early for anything that is not in `DIRECTIONS`, so a non-direction
  action can never be interpreted as movement again.
- Verified with a new gamepad harness (fake `navigator.getGamepads` + the real
  RAF poll loop): holding A keeps the focus, releasing activates exactly once,
  a 700 ms hold opens the context menu without activating, and D-pad up still
  moves the focus. 10 checks. Re-running them against a copy of the file with
  both layers reverted reproduces the bug (focus jumps up, activation lands on
  the wrong row), so the test is meaningful. The other suites are unchanged:
  24 + 35 in the tv harnesses and 32 in the jsdom render pass.

## Fix: focus alternated with the sticky chrome instead of walking the list

Two symptoms, one cause: on the player page, ↑ through the queue alternated
between a queue row and the player; in the browser, ↑ from the top visible row
jumped to the top nav bar instead of scrolling the list up.

- Cause: `moveFocus()` scored candidates by pure screen geometry in a single
  pass. The sticky player and the sticky header float *over* the scrolled
  content, so a queue row and a player control — or a list row and a header
  button — can look equally close "above" the current element:
  - the top visible queue row and the seek bar above it are ~55–63 px apart,
    so the seek bar sometimes won → focus went to the player, and the next ↓
    came back to a row (the alternating jank);
  - a row scrolled behind the header has the *same* centre as a header button
    (both in the 0–60 px band), an exact tie that DOM order resolved in favour
    of the nav bar.
- Fix, three parts in `tv.js`:
  - **Region preference** (`regionOf()`): navigation prefers candidates in the
    same region as the current element — `main` content, `.app-header`, the
    player's `.video-area`. Four passes, most specific first: same region
    without wrapping, any region without wrapping, then the same two with
    wrap-around. A list is walked to its edge (last row → info card → player,
    or last row → toolbar → header) before any other region is considered.
  - **Tie-break nudge**: aligned candidates score `primary + secondary * 0.05`,
    so a full-width row beats an equally distant header button that is off to
    the side.
  - **Wrap is now a last resort** (it used to be part of the single pass), so
    leaving a list at its edge always wins over cycling inside it.
- `revealFocus()` (previous commit) then scrolls the chosen row out from under
  whichever overlay covers it, so each step is visible.
- Verified: the queue harness now reproduces the jank with a realistically
  tall seek bar — reverting only the region preference makes it focus
  `vc-seek` then a `file-row` (exactly the reported alternation) — and a new
  browse harness (7 checks) reproduces the nav-bar jump when the region rule
  and the tie-break are both reverted. With the fix: 24 + 35 + 10 + 7 harness
  checks and the 32-check jsdom render pass are all green.

## Fix: controller sliders, prev/next focus and jumpy scrolling

Three follow-ups from TV use: the volume rocker only worked with the keyboard,
“next” moved the cursor onto play/pause, and long lists never scrolled fully
to the top or bottom.

- **Sliders (and selects) under a gamepad** — `pollGamepads()` called
  `moveFocus()` straight for D-pad/stick directions, bypassing the keyboard's
  axis rules, so `data-tv-axis`/`data-tv-step` were never consulted: ↑/↓ on the
  rocker just moved the focus and the volume could not be changed with a
  controller (an armed `<select>` had the same problem). Both devices now go
  through a shared `navigate(dir)`: armed select → step, slider on its own axis
  → step, everything else → `moveFocus`. `handleDirection()` is now just
  `consume()` + `navigate()`.
- **“Next” must not steal the cursor** — `start()` puts the phase in
  `loading`, which hides `.vcontrols` (`v-show`), and hiding an element that
  contains the focused button drops the focus to `<body>`. The `phase`
  watcher then focused `.vc-center`. `onTvFocusIn` now remembers the last
  control inside `.video-area` (`_tvLastControl`) and the watcher restores it
  when playback is ready (`TvMode.focusElement`, guarded by `isConnected`,
  `disabled` and `getClientRects().length`), falling back to
  `TvMode.focusFirst()` only when there is nothing to restore.
- **Scrolling** — the app sets `html { scroll-behavior: smooth }`, so
  `scrollIntoView()` *animated*, while `revealFocus()` measured straight
  afterwards. Every navigation did two scrolls computed from a position that
  had not settled yet: jitter on the way down and a half-scrolled page on the
  way up. New `instantScroll()` sets `scroll-behavior: auto` inline for the
  duration of a navigation scroll (and restores it), so `scrollIntoView` +
  `revealFocus` are immediate and deterministic — the reveal converges in one
  or two measured passes.
- **Fully up / fully down** — new `scrollToRegionEdge()`: when the focus
  arrives at the *first* focusable of its region the page scrolls to the top,
  and at the *last* one it scrolls to the bottom. Revealing a row leaves it 8 px
  under the sticky overlay, which used to keep the toolbar (browser) or the
  info card (queue) partly out of view after the final Up.
- Verified: harness3 gained D-pad slider checks (→/← leave the rocker
  untouched, ↑/↓ change it with the repeat behaviour, seek bar keeps the
  horizontal axis) — reverting the gamepad path reproduces the bug (volume
  stuck at 0.5, focus on a row); harness2 gained boundary checks (reaching the
  first queue item scrolls to 0, reaching the last scrolls to the document
  height); harness4 checks the browse page scrolls fully up at the first row.
  Totals: 24 + 38 + 19 + 8 harness checks plus the 32-check jsdom render pass.

----

## 2026-11-15 — Full TV/keyboard/gamepad/remote navigation overhaul

End-to-end audit and rewrite of the navigation engine (`public/js/tv.js`) and
its component integrations (`FileManager.js`, `Home.js`, `VideoPlayer.js`,
`SettingsPanel.js`, `style.css`) after recurring spatial/scroll/input issues:

- **Spatial picker (`scoreHorizontal` / `scoreVertical` / `moveFocus`)**:
  - Horizontal (`←`/`→`) now stays strictly within the same visual row
    (`vOverlap > -12`) and the same region — pressing Left/Right at the edge
    of a gallery grid or list never teleports 2000 px up to `up-btn`,
    `sort-select`, `reload`, or `.app-header`.
  - Vertical (`↑`/`↓`) uses edge-to-edge scoring (`dy * 2.5 + dx +
    centerDiff * 0.05`) instead of a strict `aligned || loose` bucket that
    used to skip entire rows in Settings and the player.
  - Cross-region transitions enforce the page's structural vertical order
    (`.app-header` 0 → `.video-area` 1 → `main` 2 via `regionRank`), so
    sticky chrome can never be entered in the wrong direction.
  - Removed vertical page wrap (holding Down at the bottom of a long list no
    longer catapults focus back to the top); kept wrap only inside compact
    popup menus (`.row-menu`, `.vc-quality`).
  - Fullscreen scoping: `activeScope()` scopes `candidates()` to
    `document.fullscreenElement` when active, so invisible header/queue
    elements behind fullscreen can never take focus.
- **Deterministic, container-aware scrolling (`scrollToFocus` /
  `scrollToRegionEdge`)**:
  - Replaced `scrollIntoView` + `elementFromPoint` (which broke inside
    scrollable modals and measured tiny child buttons inside `.vcontrols`
    instead of `.video-area` / `.app-header`) with exact container math:
    scrolls inner `overflow-y: auto` containers (`.settings-body`,
    `.modal-card`, `.vc-quality`, `.tag-fs`), horizontal overflow containers
    (`.breadcrumbs`, `.drive-row`), and the page itself with exact
    `stickyTopInset()` clearance.
  - Geometric edge check (no candidate further in `dir` within the region,
    replacing the broken DOM `list[0] === el` check) scrolls cleanly to `0`
    or `maxScroll` regardless of which column or row button is focused.
- **Arm-to-edit for text inputs and `<select>` parity**:
  - Text inputs (`search-input`, etc.) no longer trap arrow keys when passing
    through; Enter / click / programmatic focus / typing arms them
    (`.tv-armed` dashed ring), Escape or ↑/↓ (single-line) disarms them.
  - Gamepad `A` now toggles (disarms) an armed `<select>` instead of
    re-arming it; `Backspace` / `Escape` / gamepad `B` disarm an armed
    `<select>` or `<input>` before closing layers or navigating back.
- **Layer lifecycle & focus memory**:
  - Closing any modal/sheet/menu restores focus to `lastPageFocus` (the
    opener element) instead of dropping focus to `<body>`.
  - `layer()` ignores Vue `-leave-active` transitioning overlays so closing
    Settings doesn't trap focus during its 250 ms animation.
  - `SettingsPanel.js` now closes immediately on `Escape`; `VideoPlayer.js`
    fixes the unreachable `externalOpen` Escape check, closes `.tag-below` on
    `tv-back`, and clears `_tvLastControl` when focus leaves `.video-area`
    so opening a video from the queue lands on play/pause while prev/next
    stays on prev/next.
- **Loading / folder-return focus & `init()`**:
  - `refocus()` waits while a `.spinner` is visible in `main` and cancels on
    any user input (`clearRefocus()`) so a pending timer can never yank focus
    away. `FileManager.load()` clears `loading = false` *before* `$nextTick`
    so scroll + focus restoration see the rendered items, and remembers the
    last opened item per folder (`FOCUS_MEM` + `data-tv-path`). `Home.load()`
    refocuses once favorites render; both `Home` (`adding`) and `FileManager`
    (`editingPath`) close their inline forms on `tv-back`.
  - `TvMode.init()` restores TV mode on reload without clobbering the user's
    chosen `viewMode` or flashing the hint toast.
- **Gamepad & remote polish**:
  - Analog stick reads only the single dominant axis (`readPadDirection`) to
    prevent diagonal double-moves; polling runs only while a gamepad is
    connected (`gamepadconnected`/`gamepaddisconnected`).
  - Added remote keys (`DPadCenter`, `Accept`, `OK`, `Back`, `XF86Back`,
    `Exit`, `ContextMenu`, `Menu`), `PREFER` includes `.remote-btn-main`,
    `onKeyUp` consumes activate releases, and window `blur` cancels pending
    long-press timers.
  - `isVisible()` guards `style.opacity !== '' && Number(style.opacity) === 0`
    instead of bare `Number("") === 0`.
- Verified: `node --check` on all touched files + 5 test suites (131 checks:
  40 in `tv-audit.mjs`, 13 in `render-audit.mjs`, 32 in `render-check.mjs`,
  38 in `tv-harness2.mjs`, 8 in `tv-harness4.mjs`) — all green.

----

## Fix: Right from mute jumped to the seek bar instead of right-side player controls

- Cause: `scoreHorizontal()` allowed up to 12 px of negative vertical overlap
  (`vOverlap <= -12`). In `.vcontrols`, the 5 px `.vc-seek` bar sits ~10 px
  above `.vc-btn-row` (`vOverlap ≈ -10`), so it slipped into the horizontal
  row candidate set; because it spans across the full width, its `dx` was `0`
  and it beat the far-right quality/loop/fullscreen buttons (`dx ≈ 850`).
- Fix: require strict positive vertical overlap (`vOverlap <= 0`) in
  `scoreHorizontal()` (`public/js/tv.js`). Every true horizontal row in the
  app (including `.vc-vol-slider` vertically centered inside `.vc-btn-row`)
  has `vOverlap > 0`, while stacked rows like `.vc-seek` are strictly
  excluded from Left/Right and remain reachable via Up/Down.
- Verified: added Test 11 to `tv-audit.mjs` using exact CSS geometry of
  `.vcontrols` (prev → play → next → vol → mute → quality → loop → fullscreen
  and back, plus Up → seek); all 142 checks across 5 suites pass and LSP is
  clean.

----

## 2026-11-16 — Live transcoding reliability, compatibility & performance audit

Audited and hardened the full HLS transcoding stack across `server.js`,
`public/js/components/VideoPlayer.js`, and `public/js/castStore.js`:

- **Stability & resource lifecycle (`server.js`)**:
  - `runFfmpegManaged()` drains `stderr` into a capped 2 KB tail buffer and
    enforces a 45 s watchdog timeout, eliminating the 64 KB pipe-buffer
    deadlock that previously hung ffmpeg indefinitely on noisy/corrupt files.
  - Global priority concurrency scheduler (`withTranscodeSlot`, default 2
    concurrent runs via `TRANSCODE_CONCURRENCY`): on-demand/seek/init jobs
    always preempt background prefetch, preventing NVENC session exhaustion
    and spurious fallbacks to software decoding.
  - `VideoStream` tracks live child processes (`this._procs`) and kills them
    on `cleanup()`, resolving pending waiters with `false` so no HTTP request
    hangs. New `DELETE /api/video/stream/:id` and `POST /api/video/stream/:id/stop`
    (for `sendBeacon`) endpoints tear down sessions immediately on navigation,
    quality change, or tab close. Stale `CACHE_DIR` subdirectories are cleared
    on startup, and `SIGINT`/`SIGTERM` clean up all active sessions.
  - Bounded lookahead pipeline (`PIPELINE_LOOKAHEAD = 20` segments ≈ 2 min):
    pauses when the window ahead of `_activeIndex` is full (stopping paused
    movies from pegging GPU / filling `/tmp` tmpfs) and restarts automatically
    when playback advances or seeks.
- **Media compatibility & fMP4 correctness (`server.js`)**:
  - Explicit `-map 0:v:0 -map 0:a:0? -sn -dn` so embedded subtitles, data
    streams, and attached cover art no longer crash `-f mp4` muxing, and
    silent videos transcode cleanly.
  - `-pix_fmt yuv420p` + explicit H.264 `high` / HEVC `main` profiles fix
    10-bit (`yuv420p10le`), 4:2:2, and 4:4:4 sources; `-ac 2 -ar 48000`
    downmixes 5.1/7.1 surround audio to MSE-safe stereo AAC.
  - Short-edge scaling (portrait `1080×1920` at 720p → `720×1280` instead of
    `406×720`), odd-dimension rounding (`scale=trunc(iw/2)*2:trunc(ih/2)*2`),
    and rotation-aware `getVideoMetadata()` (ignoring `attached_pic`, adding
    `pixFmt` + duration fallbacks + 15 s timeout).
  - Fixed `-video_track_timescale 90000` guarantees `init.mp4` and every
    segment share the same timescale and avoids 32-bit `tfdt` overflow.
  - Atomic `finalizeFmp4Segment()` writes to a temp file and renames only
    after box stripping + clamped `tfdt` patching succeed (eliminating the
    race where `seg.cached = true` exposed unfinalized files), and caches
    `ftyp+moov` to `init.mp4` for free. `_ensureInit()` uses a 1-frame probe
    with `walkBoxes()` and software-decode fallback.
  - Tiny trailing tails (`< 0.5 s`) fold into the previous segment (`buildSegmentTable`),
    preventing 0-frame EOF segment errors; fMP4 playlists emit
    `#EXT-X-VERSION:7` and dynamic `TARGETDURATION`; segments/init are served
    via `res.sendFile()` (proper `Content-Length`, safe error/abort handling).
- **Client & cast fixes (`VideoPlayer.js`, `castStore.js`)**:
  - `VideoPlayer` sends `?start=<resumeSeconds>` to `/api/video/stream/start`
    and sets `hls.js` `startPosition`, eliminating wasted segment 0–2 transcoding
    on resume/quality switch.
  - `_startSeq` generation guard prevents rapid prev/next switches from
    attaching stale streams; tracked `_onLoaded` is cleaned up on teardown;
    duplicate event listeners removed; `pagehide` & `cleanup()` tear down the
    server stream; HTTP 404 on expired sessions triggers immediate recovery
    instead of 30 s of retries; `activeCodec` uses the server's actual codec;
    `canDirectPlay()` allows silent videos and `vp8` while rejecting 10-bit
    H.264.
  - `CastStore.cast()` now forwards `res`/`cq`/`speed`/`codec` to
    `/api/castor/cast`, and `server.js` tears down replaced or failed cast
    transcode sessions.
- Verified end-to-end against a live server with real ffmpeg + ffprobe
  (`transcode-test.mjs`: 26/26 checks across 10-bit+5.1+SRT MKV, odd-dim
  silent yuv444p MKV, portrait 1080×1920, 12.15 s tiny tail, `?start=12`
  resume, sample MP4, and DELETE/stop cleanup) plus 96 frontend checks.

----

## 2026-11-16 — TV player auto-hide, uniform full-width grids & TV gallery view

Four improvements across TV mode and the file browser:

- **Video player UI auto-hides in TV mode**:
  - Removed the TV-mode block from `VideoPlayer.scheduleHide()` /
    `hideControls()` (still kept visible while paused or while quality / tags /
    cast / external modals are open).
  - When the overlay fades out while focus is inside `.video-area`, focus
    silently parks on `.video-area` (given `tabindex="0"` while hidden, with
    `.tv-mode .video-area.tv-focus { outline: none; box-shadow: none; }` so
    the playing video has zero overlay or ring).
  - `tv.js` dispatches a cancelable `tv-input` event before direction/select
    actions. `VideoPlayer.onTvInput()` intercepts direction/select while
    hidden to wake the overlay and restore focus to `_tvLastControl` (without
    blindly activating an invisible button), lets `back` pass straight through
    to exit fullscreen, and resets the 3 s timer on every press while visible.
    Navigating Up from the queue or Down from the header into `.video-area`
    wakes the overlay automatically via `onTvFocusIn`.
- **Fixed diagonal vertical jumps on uneven-height grid tiles**:
  - `.gallery-cell` (`display: flex`) + `.gallery-card` (`height: 100%`) make
    every tile in a grid row stretch to the exact same height regardless of
    1-line vs 2-line titles.
  - `scoreVertical()` in `tv.js` also weights off-column candidates higher
    (`dy * 2.5 + dx * 2 + cx * (hOverlap > 0 ? 0.05 : 0.35)`), so even
    uneven-height tiles never pull Up/Down diagonally into a neighbour column
    while ragged Settings rows still walk cleanly row-by-row.
- **Fourth display mode (`gallery-tv`)**:
  - New `gallery-tv` view mode (bigger `360px` tiles, 76 px icons, 44 px play
    badge, 1.32 rem bold titles, 1 rem subtitles, subtle 1.03× focus lift in
    TV mode) plus `gridTv` icon in `icons.js`.
  - Toolbar cycles `list → gallery → gallery-lg → gallery-tv → list`;
    Settings → Layout stacks cleanly (`.setting-row-stack` + `.segmented-fill`)
    with all four options (`List`, `Small`, `Large`, `TV`); toggling TV mode
    on now defaults to `gallery-tv`.
- **Full-width gallery grids**:
  - Removed `max-width: 1100px` from `.gallery-grid` so all three gallery
    modes (`gallery`, `gallery-lg`, `gallery-tv`) fill wide screens with more
    columns per row (responsive `minmax(min(..., 100%), 1fr)` keeps mobile
    overflow-free).
- Verified: `tv-audit.mjs` (57/57, incl. uneven-height grid & `tv-input` wake
  tests), `player-tv-autohide.mjs` (9/9, real Vue player 3 s auto-hide + wake
  + 4-option SettingsPanel), `render-check.mjs` (37/37, 4-mode cycle + 76 px
  TV icons), `render-audit.mjs` (13/13), `tv-harness2.mjs` (38/38),
  `tv-harness4.mjs` (8/8).
