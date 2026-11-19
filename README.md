# SrvFiles

A self-hosted file browser with on-demand video transcoding. Browse the
whole filesystem, open any video, and stream it in the browser with
instant seeking — nothing is downloaded in advance; every 6-second
segment is transcoded when you reach it.

## Features

- Browse the entire filesystem (folders, videos, images, audio)
- **Three display modes** for every folder — the compact list, a **gallery**
  of 16:9 thumbnails and a **large gallery** — switched with the toolbar
  button (list → gallery → large → list) or in Settings. Thumbnails are
  rendered with ffmpeg on first view and cached in the temp dir, so a
  folder only pays that cost once; files without a preview (audio, text)
  fall back to their type icon
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
  (space, ←/→, M, F, L, N, P)
- Save the original file to disk, open it in an external player (VLC,
  nPlayer, …) or copy a direct stream link
- **Tagging & ratings** — tag videos from an overlay in the player
  (right side in fullscreen, below the player otherwise) and rate them
  1–5 stars; tags are organized in exclusive groups (e.g.
  work/personal, sunny/cloudy/rainy) and managed on a dedicated page;
  everything is stored server-side in a SQLite database
  (`data/tags.db`)
- **Folder actions (⋮ menu on folder rows)** — download a whole folder
  as a ZIP file, or delete it (with its contents) after confirmation
- **Home menu** — the landing page (root URL and the house icon) lists
  your favorite folders (defaults: `/mnt`, `/media`) with an
  Add button; favorites are stored server-side in `data/home.json`
- **Cast to a Castor receiver** — send a video over the LAN to **Castor**,
  the companion receiver app (it plays the URL or file path it is handed).
  Cast from the button in the player's top bar, or from the ⋮ menu on any
  video row. Receivers are discovered over mDNS (`_castor._tcp`) or added
  by IP; each is configured as either **Local file** (the receiver runs on
  this same host and reads the file directly) or **Transcode** (the
  receiver is another device: formats it can't play are transcoded to HLS
  on the fly, browser-compatible files stream as-is)
- **Cast remote mode** — casting is a session, not a one-off: starting a
  cast stops local playback and turns the player into a remote control for
  the receiver (play/pause, seek and ±10 s, volume, fullscreen, quality).
  Opening any other video keeps casting to the same receiver until you
  press **Disconnect & watch here**; the session survives a reload, and
  when the video ends the next file in the folder is cast automatically
  (honours the “auto next” setting)
- **TV mode** — pointer-free navigation for Bluetooth remotes, game
  controllers and keyboard-only setups. Toggle it with the TV icon in the
  header: ←/→/↑/↓ move the focus between buttons, rows and controls, Enter
  or Space activates, Backspace closes the open menu/dialog, leaves
  fullscreen, goes up a folder or goes back. On a focused slider ←/→ step
  the value (seek 10 s, volume 5 %) while ↑/↓ leave it; a dropdown only
  takes the arrows after it has been opened. The player gets a play/pause
  button in its control bar. TV mode also hides everything that is not
  media (folders, videos, images and audio only) and starts on the large
  gallery layout — leaving it restores the list. Gamepads are read through
  the Gamepad API (D-pad, left stick, A = select, B = back); the mode is
  remembered per browser
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

The tagging database lives in `data/` next to `server.js` (created on
first use). In Docker it is persisted via the `srvfiles-data` volume.

## API (tags)

- `GET /api/tags` — all groups and tags
- `POST /api/tags` / `PUT /api/tags/:id` / `DELETE /api/tags/:id` — manage tags
- `POST /api/groups` / `PUT /api/groups/:id` / `DELETE /api/groups/:id` — manage groups
- `GET /api/video/tags?path=…` — tags + rating of one video
- `PUT /api/video/tags` — set `{ path, tagIds, rating }` (rating 1–5 or `null`)
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
  (a frame ~2 s in for videos, the scaled image for pictures). Generated
  with ffmpeg on first request, cached in the OS temp dir keyed by
  path + mtime + size, at most two ffmpeg runs at a time. Responds 404
  when a file has no still frame (audio, text, …) so the UI can fall back
  to an icon

## API (casting to a Castor receiver)

- `GET /api/castor/receivers` — `{ discovered, saved }`: receivers found
  over mDNS plus the ones saved in `data/castor-receivers.json` (probed
  for online state)
- `POST /api/castor/receivers` — add/update a receiver, body
  `{ url, name?, mode?, pin? }` where `mode` is `local` or `remote`
  (default); the URL is probed first and the request fails with 502 if no
  receiver answers. `DELETE /api/castor/receivers?id=…` removes one
- `POST /api/castor/cast` — cast a file, body
  `{ path, receiverId | receiverUrl, mode }`; responds with the mode,
  backend (`local-file` / `direct-file` / `hls-transcode`) and the
  receiver's playback state
- `POST /api/castor/command` — transport passthrough, body
  `{ receiverId | receiverUrl, command, body? }` where `command` is one
  of play/pause/stop/toggle/seek/seek-relative/volume/next/previous/
  fullscreen
- `GET /api/castor/state?receiverId=…|receiverUrl=…` — the receiver's
  current playback state

Client-side, the casting session lives in `public/js/castStore.js`
(`CastStore.state`): the active receiver, the cast path, a 2 s poll of
`/api/castor/state` and the transport commands. It is persisted to
`localStorage` (`srvfiles-cast`) so remote mode survives reloads, and it
drives auto-next by casting the next sibling file when the receiver goes
`stopped`.

Note: discovery needs LAN multicast, which a Docker **bridge** network
blocks — run the container with `network_mode: host` (see
`docker-compose.yml`) to enable it. Adding a receiver manually always
works.

## Security

This app serves the entire filesystem of the machine it runs on, with
no authentication. Only use it on trusted networks, and consider
putting it behind a reverse proxy with authentication if it is
reachable from other networks.