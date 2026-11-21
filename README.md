# SrvFiles

A self-hosted file browser with on-demand video transcoding. Browse the
whole filesystem, open any video, and stream it in the browser with
instant seeking — nothing is downloaded in advance; every 6-second
segment is transcoded when you reach it.

## Features

- Browse the entire filesystem (folders, videos, images, audio)
- **Four display modes** for every folder — the compact list, a **small
  gallery**, a **large gallery**, and a **TV gallery** (big tiles, big icons,
  10-foot typography) — switched with the toolbar button (list → small →
  large → TV → list) or in Settings. All three grids span the full viewport
  width so wide screens fit more items per row, and every tile in a row
  shares the same height. Thumbnails are rendered live by ffmpeg and held
  **in memory only** (nothing is written to disk); files without a preview
  (audio, text) fall back to their type icon. Gallery tiles have no ⋮ button
  — a long press (or right click, or a held select on a remote/controller)
  opens a folder's download/delete menu
- On-demand HLS transcoding — start watching instantly, seek anywhere
- Hardware-accelerated transcoding when available (NVIDIA NVENC/NVDEC,
  Intel QSV, AMD AMF, VAAPI), automatic fallback to software
- Streaming quality settings (resolution / quality / encoding speed)
  that persist per browser
- Optional HEVC output (~40% less bandwidth), auto-selected only for
  devices that can decode it
- Direct playback of browser-compatible files ("Original" quality)
- Mobile-friendly player UI: volume HUD, play/pause burst, hover
  volume slider, double-click fullscreen, keyboard shortcuts
  (space / P play-pause, ←/→ ±10 s, K mute, F fullscreen, L loop, M next,
  N previous; Space pauses silently without revealing the overlay when
  fullscreen and hidden)
- Save the original file to disk, open it in an external player (VLC,
  nPlayer, …) or copy a direct stream link
- **Folder actions (⋮ menu on folder rows)** — download a whole folder
  as a ZIP file, or delete it (with its contents) after confirmation
- **Home menu** — the landing page (root URL and the house icon) lists
  your favorite folders (defaults: `/mnt`, `/media`) with an
  Add button; favorites are stored server-side in `data/home.json`
- **TV mode** — pointer-free navigation for Bluetooth remotes, game
  controllers and keyboard-only setups. Toggle it with the TV icon in the
  header: ←/→/↑/↓ move the focus between buttons, rows and controls, Enter
  or Space activates (on release), Backspace closes the open menu/dialog,
  leaves fullscreen, goes up a folder or goes back. **Holding** Enter/Space
  (or A on a controller) opens the focused item's actions menu. A slider owns
  only the axis it is drawn along — with a keyboard, a remote *or* a
  controller — so nothing traps the arrows: the seek bar
  takes ←/→ (10 s steps) and lets ↑/↓ move on, the volume rocker takes ↑/↓
  (5 % steps) and lets ←/→ move on. A dropdown takes the arrows only after it
  has been opened. Long lists stay walkable: a row that is scrolled under a
  sticky player or header is focused *and* scrolled clear of it instead of
  being skipped. The player gets a
  play/pause button in its control bar, and its overlay fades out cleanly
  after 3 s of playback (waking on any remote/keyboard/gamepad press). TV
  mode also hides everything that is not media (folders, videos, images and
  audio only) and starts on the TV gallery layout — leaving it restores the
  list. Gamepads are read through the Gamepad API (D-pad, left stick, A =
  select, B = back); the mode is remembered per browser. On the video
  player, Xbox-layout gamepads also map A (select / silent play-pause when
  fullscreen with hidden overlay), Start (fullscreen), LT/RT (previous/next
  video), Y (loop) and X (quality settings)
- Dark / light themes, search and sorting

## Run directly (Node.js)

Requires Node.js and ffmpeg (hardware encoding used automatically when
available).

```sh
npm install
npm start
```

Then open http://localhost:3000. The server serves the filesystem root
of the machine it runs on.

## Run with Docker

```sh
docker compose up -d --build
```

The whole **host filesystem is mounted into the container** at `/host`
and served with clean paths — browsing to `/media/movies` in the UI
shows the host's `/media/movies`. Nothing is copied into the container.

Notes:

- **GPU transcoding** requires the [NVIDIA container
  toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/)
  on the host. On non-NVIDIA hosts, comment out the `deploy.resources`
  block in `docker-compose.yml` — the server falls back to software
  transcoding automatically.
- The mount is read-write by default; switch to `/:/host:ro` if you
  prefer. Since it mounts `/`, the container can also see the host's
  docker socket (`/host/var/run/docker.sock`) — treat it accordingly,
  or mount read-only.
- The transcoding cache lives in the container's `/tmp` and is
  discarded with the container.

## Configuration

| Env var    | Meaning                                                        |
|------------|----------------------------------------------------------------|
| `PORT`     | HTTP port (default `3000`)                                     |
| `HOST_ROOT`| Where the host filesystem is mounted inside the container (default unset = serve `/` directly; Docker compose sets `/host`) |

Persistent app data (such as home menu favorites) lives in `data/` next
to `server.js` (created on first use). In Docker it is persisted via the
`srvfiles-data` volume.

## API (folders)

- `GET /api/download/zip?path=…` — stream a folder as a ZIP download
  (folder is the zip root; hidden files included)
- `DELETE /api/folder?path=…` — delete a folder and all contents
  (filesystem roots are refused)

## API (home menu)

- `GET /api/home/folders` — favorite folders shown on the home page
  (defaults to `/mnt` and `/media`; persisted in `data/home.json`)
- `POST /api/home/folders` — add a favorite, body `{ path }` (must be an
  existing directory); returns the updated list
- `DELETE /api/home/folders?path=…` — remove a favorite;
  returns the updated list

## API (for external players)

- `GET /api/video/raw?path=/some/file.mp4` — the original file, with
  HTTP Range support (works in VLC's "Open Network Stream", etc.)

## API (thumbnails / browsing)

- `GET /api/browse?path=/some/folder` — directory listing; every entry
  carries `isDirectory` / `isVideo` / `isImage` / `isAudio` flags so the
  client can filter without knowing the extension lists
- `GET /api/thumb?path=/some/file.mp4` — a 480 px-wide JPEG preview
  (a frame ~2 s in for videos, the scaled image for pictures), rendered
  live by ffmpeg and kept **in memory only** (never written to disk; the
  process keeps up to 64 MB, oldest entry evicted first, and answers
  `Cache-Control: no-store`). Renders are capped at two at a time and
  identical requests share one. Responds 404 when a file has no still
  frame (audio, text, …) so the UI can fall back to an icon

## Security

This app serves the entire filesystem of the machine it runs on, with
no authentication. Only use it on trusted networks, and consider
putting it behind a reverse proxy with authentication if it is
reachable from other networks.