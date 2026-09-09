const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.join(os.tmpdir(), 'srvfiles-cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use(express.static('public'));

function findFfmpeg() {
  const candidates = ['ffmpeg', 'ffmpeg.exe'];
  for (const cmd of candidates) {
    try {
      const out = execSync(cmd + ' -version', { stdio: 'pipe' });
      if (out) return cmd;
    } catch (_) {}
  }
  const paths = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findFfprobe() {
  const base = findFfmpeg();
  if (!base) return null;
  const dir = path.dirname(base);
  const probe = path.join(dir, 'ffprobe' + (base.endsWith('.exe') ? '.exe' : ''));
  if (fs.existsSync(probe)) return probe;
  try {
    execSync('ffprobe -version', { stdio: 'pipe' });
    return 'ffprobe';
  } catch (_) {}
  return null;
}

const FFMPEG = findFfmpeg();
const FFPROBE = findFfprobe();

console.log('ffmpeg:  ' + (FFMPEG || 'NOT FOUND'));
console.log('ffprobe: ' + (FFPROBE || 'NOT FOUND'));

// ─── Hardware encoder detection ────────────────────────────────────────────────
const HW_ENCODERS = ['h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_vaapi'];
const ENCODER = detectHwEncoder();
console.log('encoder: ' + ENCODER);

// ─── Encoding quality / speed presets ──────────────────────────────────
// resolution: max output height, 0 = keep original (never upscales)
// quality:    encoder quality dial (CQ/CRF-ish, lower = better looking).
//             Mapped per codec: hevc cq31 ≈ h264 cq27 in visual quality
//             while using ~35-40% less bitrate (measured on NVENC).
// speed:      encoder preset — faster = less CPU/GPU per frame but worse
//             compression (more bitrate) at the same quality
const RESOLUTIONS = { 480: 480, 720: 720, 1080: 1080, orig: 0 };
const QUALITIES = {
  h264: { low: 30, medium: 27, high: 24 },
  hevc: { low: 34, medium: 31, high: 28 },
};

// Per-encoder preset maps for the speed setting
const SPEED_PRESETS = {
  h264_nvenc: { fast: 'p1', balanced: 'p4', best: 'p6' },
  hevc_nvenc: { fast: 'p1', balanced: 'p4', best: 'p6' },
  h264_qsv:   { fast: 'veryfast', balanced: 'medium', best: 'slow' },
  h264_amf:   { fast: 'speed', balanced: 'balanced', best: 'quality' },
  libx264:    { fast: 'veryfast', balanced: 'medium', best: 'slow' },
  h264_vaapi: { fast: null, balanced: null, best: null }, // no preset support
};

function parseEncOptions(query) {
  const codec = (query.codec === 'hevc' && HEVC_AVAILABLE) ? 'hevc' : 'h264';
  const resolution = RESOLUTIONS.hasOwnProperty(query.res) ? RESOLUTIONS[query.res] : 720;
  const qualityMap = QUALITIES[codec];
  const quality = qualityMap.hasOwnProperty(query.cq) ? qualityMap[query.cq] : qualityMap.medium;
  const encoderName = codec === 'hevc' ? 'hevc_nvenc' : ENCODER;
  const speed = SPEED_PRESETS[encoderName] && ['fast', 'balanced', 'best'].includes(query.speed)
    ? query.speed : 'fast';
  return { codec, resolution, quality, speed, format: codec === 'hevc' ? 'fmp4' : 'ts' };
}

function detectHwEncoder() {
  if (!FFMPEG) return 'libx264';
  for (const enc of HW_ENCODERS) {
    try {
      // Note: 256x256 because NVENC rejects resolutions below ~145x49,
      // which made the old 64x48 probe always fail on NVIDIA GPUs
      execSync(
        FFMPEG + ' -hide_banner -f lavfi -i nullsrc=s=256x256 -frames:v 1 -c:v ' + enc +
        ' -f null - 2>&1',
        { stdio: 'pipe', timeout: 5000 }
      );
      return enc;
    } catch (_) {}
  }
  return 'libx264';
}

// ─── Hardware decoder (NVDEC) detection ────────────────────────────────────
// Offloads video DECODING to the GPU (NVDEC on NVIDIA). Frames are decoded on
// the GPU and downloaded to system memory, so pixel-format handling and the
// encoder input are unchanged. Only enabled alongside the NVENC encoder;
// streams whose codec NVDEC cannot handle fall back to software decoding.
const NVDEC_CODECS = new Set([
  'h264', 'hevc', 'mpeg1video', 'mpeg2video', 'mpeg4', 'vc1', 'vp8', 'vp9', 'av1'
]);
const DECODE_ARGS = detectHwDecode();
console.log('decoder: ' + (DECODE_ARGS.length ? 'NVDEC (hwaccel cuda)' : 'software'));

// HEVC encoding (only via NVENC on NVIDIA; requires RTX 30+ for hardware HEVC)
const HEVC_AVAILABLE = detectHevcEncoder();
console.log('hevc encode: ' + (HEVC_AVAILABLE ? 'available (hevc_nvenc, fMP4 HLS)' : 'not available'));

function detectHevcEncoder() {
  if (ENCODER !== 'h264_nvenc') return false;
  try {
    execSync(
      FFMPEG + ' -hide_banner -f lavfi -i nullsrc=s=256x256 -frames:v 1 -c:v hevc_nvenc' +
      ' -f null - 2>&1',
      { stdio: 'pipe', timeout: 5000 }
    );
    return true;
  } catch (_) {
    return false;
  }
}

function detectHwDecode() {
  if (ENCODER !== 'h264_nvenc') return [];  // decode acceleration wired for NVIDIA only
  const probe = path.join(CACHE_DIR, 'decode-test.mp4');
  try {
    // Generate a tiny h264 clip, then try decoding it with NVDEC
    execSync(
      FFMPEG + ' -hide_banner -loglevel error -f lavfi -i testsrc2=s=256x256:d=0.3 ' +
      '-c:v libx264 -preset ultrafast -f mp4 -y "' + probe + '" 2>&1',
      { stdio: 'pipe', timeout: 20000 }
    );
    try {
      execSync(
        FFMPEG + ' -hide_banner -loglevel error -hwaccel cuda -i "' + probe +
        '" -frames:v 1 -f null - 2>&1',
        { stdio: 'pipe', timeout: 20000 }
      );
      return ['-hwaccel', 'cuda'];
    } finally {
      try { fs.unlinkSync(probe); } catch (_) {}
    }
  } catch (_) {
    return [];
  }
}

/** Build ffmpeg arguments for transcoding a segment */
function buildTranscodeArgs(seg, filePath, decodeArgs, enc) {
  // Hardware decode flags must come before the input they apply to
  const args = (decodeArgs || []).slice();
  args.push(
    '-ss', String(seg.startTime),
    '-i', filePath,
    '-t', String(seg.duration)
  );

  // Downscale when requested and the source is larger (never upscale).
  // -2 keeps the aspect ratio and an even height (required by h264).
  const enc_ = enc || { resolution: 0, quality: 23, speed: 'fast' };
  if (enc_.resolution > 0) {
    args.push('-vf', 'scale=-2:' + enc_.resolution);
  }

  // Add video encoder flags
  const q = enc_.quality;
  const isHevc = enc_.codec === 'hevc';
  const encoderName = isHevc ? 'hevc_nvenc' : ENCODER;
  const preset = (SPEED_PRESETS[encoderName] || {})[enc_.speed];
  if (isHevc) {
    // HEVC only exposed via NVENC (gated by HEVC_AVAILABLE)
    args.push(
      '-rc', 'vbr',
      '-cq', String(q),
      '-c:v', 'hevc_nvenc',
      '-tag:v', 'hvc1'   // Apple-style tag, expected by browser decoders
    );
    if (preset) args.push('-preset', preset);
  } else if (ENCODER === 'h264_qsv') {
    args.push(
      '-global_quality', String(q),
      '-c:v', 'h264_qsv'
    );
    if (preset) args.push('-preset', preset);
  } else if (ENCODER === 'h264_nvenc') {
    args.push(
      '-rc', 'vbr',
      '-cq', String(q),
      '-c:v', 'h264_nvenc'
    );
    if (preset) args.push('-preset', preset);
  } else if (ENCODER === 'h264_amf') {
    args.push(
      '-rc', 'cqp',
      '-qp_i', String(q), '-qp_p', String(q),
      '-c:v', 'h264_amf'
    );
    if (preset) args.push('-quality', preset);
  } else if (ENCODER === 'h264_vaapi') {
    args.push(
      '-global_quality', String(q),
      '-c:v', 'h264_vaapi'
    );
  } else {
    args.push(
      '-crf', String(q),
      '-c:v', 'libx264'
    );
    if (preset) args.push('-preset', preset);
  }

  // Audio, PTS offset, and output
  args.push('-output_ts_offset', String(seg.startTime));
  args.push('-c:a', 'aac', '-b:a', '128k');
  if (enc_.format === 'fmp4') {
    // Fragmented MP4 (one fragment file per HLS segment; the moov init part
    // is served separately as init.mp4 — see _ensureInit)
    args.push(
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4'
    );
  } else {
    args.push('-muxdelay', '0', '-f', 'mpegts');
  }
  args.push('-y', seg.path);
  return args;
}

function sanitizePath(rawPath) {
  try {
    return path.resolve(path.normalize(rawPath || ''));
  } catch (_) {
    return null;
  }
}

function safePath(rawPath) {
  const sp = sanitizePath(rawPath);
  if (!sp || !fs.existsSync(sp)) return null;
  return sp;
}

const VIDEO_EXT = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.vob', '.ogv', '.3gp',
  '.divx', '.xvid', '.rm', '.rmvb'
]);

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif'
]);

function isVideo(file) {
  return VIDEO_EXT.has(path.extname(file).toLowerCase());
}

function isImage(file) {
  return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    if (!FFPROBE) return reject(new Error('ffprobe not found'));
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    const proc = spawn(FFPROBE, args);
    let data = '';
    proc.stdout.on('data', (chunk) => { data += chunk; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const info = JSON.parse(data);
        const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
        const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');
        resolve({
          duration: info.format ? parseFloat(info.format.duration || 0) : 0,
          size: info.format ? parseInt(info.format.size || 0) : 0,
          bitrate: info.format ? parseInt(info.format.bit_rate || 0) : 0,
          width: videoStream ? videoStream.width : 0,
          height: videoStream ? videoStream.height : 0,
          codec: videoStream ? videoStream.codec_name : '',
          audioCodec: audioStream ? audioStream.codec_name : '',
          fps: videoStream ? evalFps(videoStream.r_frame_rate) : 0,
        });
      } catch (e) {
        reject(e);
      }
    });
    proc.on('error', reject);
  });
}

function evalFps(rFrameRate) {
  if (!rFrameRate) return 0;
  const parts = rFrameRate.split('/');
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    return den ? Math.round(num / den * 100) / 100 : 0;
  }
  return parseFloat(rFrameRate) || 0;
}

const streams = new Map();
const SEGMENT_DURATION = 6;

class VideoStream {
  constructor(id, filePath, encOptions) {
    this.id = id;
    this.filePath = filePath;
    this.encOptions = encOptions ||
      { codec: 'h264', resolution: 0, quality: 23, speed: 'fast', format: 'ts' };
    this.segments = [];
    this.metadata = null;
    this.cleaned = false;
    this.cacheDir = path.join(CACHE_DIR, id);
    this._pipelineIndex = 0;     // next segment to transcode in background
    this._pipelineActive = false; // whether background pipeline is running
    this._prioQueue = [];         // segments requested on-demand (seek), process these first
    this.decodeArgs = [];         // hw decode flags for this stream (set in init)
    this.initPath = path.join(this.cacheDir, 'init.mp4'); // fMP4 init segment
    this._initPromise = null;     // in-flight init generation
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async init() {
    this.metadata = await getVideoMetadata(this.filePath);
    // Never upscale: if the requested resolution exceeds the source, keep original
    if (this.encOptions.resolution > 0 && this.metadata.height &&
        this.metadata.height <= this.encOptions.resolution) {
      this.encOptions.resolution = 0;
    }
    // Use GPU decoding only for codecs NVDEC supports (others use software decode)
    this.decodeArgs = (DECODE_ARGS.length && NVDEC_CODECS.has(this.metadata.codec))
      ? DECODE_ARGS.slice()
      : [];
    const totalSegs = Math.ceil(this.metadata.duration / SEGMENT_DURATION);
    const ext = this.encOptions.format === 'fmp4' ? '.m4s' : '.ts';
    for (let i = 0; i < totalSegs; i++) {
      const startTime = i * SEGMENT_DURATION;
      const dur = Math.min(SEGMENT_DURATION, this.metadata.duration - startTime);
      this.segments.push({
        index: i,
        startTime,
        duration: dur,
        cached: false,
        transcoding: false,
        path: path.join(this.cacheDir, 'seg-' + i + ext),
        queue: []  // waiters for this segment
      });
    }
    // Immediately start the first 3 segments in parallel
    this.segments[0] && this._startTranscode(0);
    this.segments[1] && this._startTranscode(1);
    this.segments[2] && this._startTranscode(2);
    // Then start background pipeline
    this._pipelineIndex = 3;
    this._pipelineActive = true;
    setImmediate(() => this._runPipeline());
  }

  getPlaylist() {
    if (!this.metadata) return null;
    const lines = [];
    lines.push('#EXTM3U');
    lines.push('#EXT-X-VERSION:3');
    lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
    lines.push('#EXT-X-TARGETDURATION:' + Math.ceil(SEGMENT_DURATION));
    lines.push('#EXT-X-MEDIA-SEQUENCE:0');
    lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
    if (this.encOptions.format === 'fmp4') {
      lines.push('#EXT-X-MAP:URI="init.mp4"');
    }
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      lines.push('#EXTINF:' + seg.duration.toFixed(3) + ',');
      const ext = this.encOptions.format === 'fmp4' ? '.m4s' : '.ts';
      lines.push('segment-' + seg.index + ext);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\r\n');
  }

  /**
   * Start transcoding a segment if not already cached/transcoding.
   * Returns a promise that resolves when the segment is cached.
   */
  ensureSegment(index) {
    if (index < 0 || index >= this.segments.length) return Promise.resolve(false);
    const seg = this.segments[index];
    if (seg.cached) return Promise.resolve(true);
    if (seg.transcoding) {
      // Already being transcoded — queue our callback
      return new Promise((resolve) => {
        seg.queue.push(resolve);
      });
    }
    // Not started yet — start it now (on-demand / seek)
    return this._startTranscode(index);
  }

  /**
   * fMP4 init segment (codec headers only). Generated by encoding a short
   * probe with identical settings, then truncating the file at its first
   * 'moof' box so only ftyp+moov remain (a pure init segment).
   */
  _ensureInit() {
    if (this._initPromise) return this._initPromise;
    if (fs.existsSync(this.initPath)) return Promise.resolve(true);
    this._initPromise = new Promise((resolve) => {
      const probe = path.join(this.cacheDir, 'probe.mp4');
      const args = buildTranscodeArgs(
        { startTime: 0, duration: 0.3, path: probe },
        this.filePath, this.decodeArgs, this.encOptions
      );
      const proc = spawn(FFMPEG, args);
      proc.on('close', (code) => {
        this._initPromise = null;
        try {
          if (code !== 0 || !fs.existsSync(probe)) return resolve(false);
          const buf = fs.readFileSync(probe);
          // Walk top-level MP4 boxes; init = everything before the first moof
          let off = 0;
          let cut = -1;
          while (off + 8 <= buf.length) {
            const size = buf.readUInt32BE(off);
            const type = buf.toString('ascii', off + 4, off + 8);
            if (type === 'moof') { cut = off; break; }
            if (size < 8) break;
            off += size;
          }
          if (cut <= 0) return resolve(false);
          fs.writeFileSync(this.initPath, buf.slice(0, cut));
          fs.unlinkSync(probe);
          resolve(true);
        } catch (_) {
          resolve(false);
        }
      });
      proc.on('error', () => resolve(false));
    });
    return this._initPromise;
  }

  /** Internal: launch ffmpeg for a segment, notify all waiters on completion */
  _startTranscode(index) {
    return new Promise((resolve) => {
      const seg = this.segments[index];
      if (!seg) return resolve(false);
      if (seg.cached) return resolve(true);
      if (seg.transcoding) {
        seg.queue.push(resolve);
        return;
      }
      seg.transcoding = true;
      // Remember whether this attempt used hardware decode, so the fallback
      // below triggers per-segment even when several segments fail at once
      seg.usedHwDecode = this.decodeArgs.length > 0;
      const args = buildTranscodeArgs(seg, this.filePath, this.decodeArgs, this.encOptions);
      const proc = spawn(FFMPEG, args);
      proc.on('close', (code) => {
        seg.transcoding = false;
        const ok = (code === 0 && fs.existsSync(seg.path) && fs.statSync(seg.path).size > 0);
        if (ok) {
          seg.cached = true;
          const waiters = seg.queue;
          seg.queue = [];
          for (const fn of waiters) fn(true);
          resolve(true);
          return;
        }
        try { fs.unlinkSync(seg.path); } catch (_) {}
        // This segment was attempted with hardware decode and failed —
        // disable hw decoding for the whole stream and retry this segment
        // once with software decoding. Waiters stay queued and are notified
        // when the retry completes.
        if (seg.usedHwDecode) {
          seg.usedHwDecode = false;
          this.decodeArgs = [];
          console.warn('Hardware decode failed for "' + path.basename(this.filePath) +
            '", falling back to software decoding');
          this._startTranscode(index).then((ok2) => resolve(ok2));
          return;
        }
        const waiters = seg.queue;
        seg.queue = [];
        for (const fn of waiters) fn(false);
        resolve(false);
      });
      proc.on('error', () => {
        seg.transcoding = false;
        const waiters = seg.queue;
        seg.queue = [];
        for (const fn of waiters) fn(false);
        resolve(false);
      });
    });
  }

  /** Background pipeline: keep transcoding segments ahead of playback */
  async _runPipeline() {
    if (!this._pipelineActive) return;
    if (this._pipelineIndex >= this.segments.length) {
      this._pipelineActive = false;
      return;
    }
    const idx = this._pipelineIndex;
    const seg = this.segments[idx];
    // If this segment is already cached or being transcoded (e.g. user skipped to it), skip it
    if (!seg.cached && !seg.transcoding) {
      await this._startTranscode(idx);
    }
    this._pipelineIndex++;
    setImmediate(() => this._runPipeline());
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this._pipelineActive = false;
    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

app.get('/api/drives', (req, res) => {
  if (process.platform === 'win32') {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const drivePath = letter + '\\';
      try {
        if (fs.existsSync(drivePath)) {
          drives.push({ name: drivePath, path: drivePath });
        }
      } catch (_) {}
    }
    return res.json(drives);
  } else {
    const roots = ['/'];
    for (const dir of ['/mnt', '/media']) {
      try {
        if (fs.existsSync(dir)) {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const p = path.join(dir, item);
            try {
              if (fs.statSync(p).isDirectory()) roots.push(p);
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
    return res.json(roots.map(p => ({ name: p, path: p })));
  }
});

app.get('/api/browse', (req, res) => {
  const defaultPath = process.platform === 'win32' ? 'C:\\' : '/';
  const rawPath = req.query.path || defaultPath;
  const sp = safePath(rawPath);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  try {
    const items = fs.readdirSync(sp, { withFileTypes: true });
    const result = [];
    for (const dirent of items) {
      if (dirent.name.startsWith('.')) continue;
      const fullPath = path.join(sp, dirent.name);
      let stat;
      try { stat = fs.statSync(fullPath); } catch (_) { continue; }
      result.push({
        name: dirent.name,
        path: fullPath,
        isDirectory: dirent.isDirectory(),
        isVideo: isVideo(dirent.name),
        isImage: isImage(dirent.name),
        size: stat.size,
        sizeFormatted: formatSize(stat.size),
        mtime: stat.mtime
      });
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    res.json({ path: sp, parent: path.dirname(sp), contents: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/video/raw', (req, res) => {
  const sp = safePath(req.query.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  // sendFile supports HTTP Range requests, so external players / browsers can seek
  res.sendFile(sp, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
});

app.get('/api/video/metadata', async (req, res) => {
  const rawPath = req.query.path;
  const sp = safePath(rawPath);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  if (!FFPROBE) return res.status(500).json({ error: 'ffprobe not found' });
  try {
    const meta = await getVideoMetadata(sp);
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/video/stream/start', async (req, res) => {
  const rawPath = req.query.path;
  const sp = safePath(rawPath);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  if (!FFMPEG || !FFPROBE) return res.status(500).json({ error: 'ffmpeg/ffprobe not found' });
  try {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const encOptions = parseEncOptions(req.query);
    const stream = new VideoStream(id, sp, encOptions);
    await stream.init();
    streams.set(id, stream);
    scheduleStreamCleanup(id);
    function scheduleStreamCleanup(streamId) {
      stream.cleanupTimer = setTimeout(() => {
        const s = streams.get(streamId);
        if (s) { s.cleanup(); streams.delete(streamId); }
      }, 5 * 60 * 1000);
    }
    res.json({
      streamId: id,
      duration: stream.metadata.duration,
      width: stream.metadata.width,
      height: stream.metadata.height,
      codec: stream.metadata.codec,
      fps: stream.metadata.fps,
      segments: stream.segments.length,
      playlistUrl: '/api/video/stream/' + id + '/playlist.m3u8'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/video/stream/:id/playlist.m3u8', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const playlist = stream.getPlaylist();
  if (!playlist) return res.status(500).json({ error: 'Failed to generate playlist' });
  res.set({
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.send(playlist);
});

app.get('/api/video/stream/:id/segment-:index.ts', serveSegment);
app.get('/api/video/stream/:id/segment-:index.m4s', serveSegment);
app.get('/api/video/stream/:id/init.mp4', async (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  if (stream.encOptions.format !== 'fmp4') return res.status(404).json({ error: 'Not an fMP4 stream' });
  const ok = await stream._ensureInit();
  if (!ok || !fs.existsSync(stream.initPath)) return res.status(500).json({ error: 'Failed to generate init segment' });
  res.set({
    'Content-Type': 'video/mp4',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(stream.initPath).pipe(res);
});

async function serveSegment(req, res) {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const index = parseInt(req.params.index);
  if (isNaN(index)) return res.status(400).json({ error: 'Invalid segment index' });
  const ok = await stream.ensureSegment(index);
  if (!ok) return res.status(500).json({ error: 'Failed to transcode segment' });
  const segPath = stream.segments[index] ? stream.segments[index].path : null;
  if (!segPath || !fs.existsSync(segPath)) {
    return res.status(404).json({ error: 'Segment not found' });
  }
  res.set({
    'Content-Type': stream.encOptions.format === 'fmp4' ? 'video/mp4' : 'video/mp2t',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  fs.createReadStream(segPath).pipe(res);
}

app.get('/api/video/stream/:id/status', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  // Client is still polling — keep the session alive
  clearTimeout(stream.cleanupTimer);
  stream.cleanupTimer = setTimeout(() => {
    const s = streams.get(req.params.id);
    if (s) { s.cleanup(); streams.delete(req.params.id); }
  }, 5 * 60 * 1000);
  let cachedCount = 0;
  for (let i = 0; i < stream.segments.length; i++) {
    if (stream.segments[i].cached) cachedCount++;
  }
  res.json({
    totalSegments: stream.segments.length,
    cachedSegments: cachedCount,
    duration: stream.metadata ? stream.metadata.duration : 0,
    progress: stream.segments.length > 0 ? (cachedCount / stream.segments.length * 100).toFixed(1) + '%' : '0%'
  });
});

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
  if (!FFMPEG) console.log('WARNING: ffmpeg not found. Install ffmpeg for video transcoding.');
  if (!FFPROBE) console.log('WARNING: ffprobe not found. Install ffmpeg for video metadata.');
});
