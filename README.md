# SrvFiles

A self-hosted file browser with on-demand video transcoding. Browse the
whole filesystem, open any video, and stream it in the browser with
instant seeking — nothing is downloaded in advance; every 6-second
segment is transcoded when you reach it.

## Features

- Browse the entire filesystem (folders, videos, images)
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
- Dark / light themes, list/grid browsing, search and sorting

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

## API (for external players)

- `GET /api/video/raw?path=/some/file.mp4` — the original file, with
  HTTP Range support (works in VLC's "Open Network Stream", etc.)

## Security

This app serves the entire filesystem of the machine it runs on, with
no authentication. Only use it on trusted networks, and consider
putting it behind a reverse proxy with authentication if it is
reachable from other networks.