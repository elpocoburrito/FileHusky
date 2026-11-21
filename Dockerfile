# FileHusky — file browser with on-demand video transcoding
#
# The host filesystem is expected to be mounted at /host (see
# docker-compose.yml:  volumes: ["/:/host"]) and is served with clean
# client-facing paths (/media/movies/... on the host stays /media/movies).
#
# GPU (NVENC/NVDEC) support requires the NVIDIA container toolkit on the
# host and the GPU reservation in docker-compose.yml; without a GPU the
# server automatically falls back to software encoding/decoding.

FROM node:22-bookworm-slim

# ffmpeg (with NVENC/NVDEC encoders compiled in) + ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=3000 \
    HOST_ROOT=/host \
    NODE_ENV=production

EXPOSE 3000

CMD ["node", "server.js"]