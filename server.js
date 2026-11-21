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
// Clear orphaned transcode session folders left behind by a previous run/crash
try {
  for (const entry of fs.readdirSync(CACHE_DIR)) {
    fs.rmSync(path.join(CACHE_DIR, entry), { recursive: true, force: true });
  }
} catch {}

app.use(express.static('public'));
app.use(express.json());

function findFfmpeg() {
  const candidates = ['ffmpeg', 'ffmpeg.exe'];
  for (const cmd of candidates) {
    try {
      const out = execSync(cmd + ' -version', { stdio: 'pipe' });
      if (out) return cmd;
    } catch {}
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
  } catch {}
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
  const resolution = Object.hasOwn(RESOLUTIONS, query.res) ? RESOLUTIONS[query.res] : 720;
  const qualityMap = QUALITIES[codec];
  const quality = Object.hasOwn(qualityMap, query.cq) ? qualityMap[query.cq] : qualityMap.medium;
  const encoderName = codec === 'hevc' ? 'hevc_nvenc' : ENCODER;
  const speed = SPEED_PRESETS[encoderName] && ['fast', 'balanced', 'best'].includes(query.speed)
    ? query.speed : 'fast';
  // fMP4 for both codecs. The legacy per-segment MPEG-TS output had AAC
  // frame-boundary overlaps between consecutive segments (each segment is
  // encoded independently, so audio snaps to its own frame grid), which
  // Chrome's MPEG-TS MSE parser rejects as non-monotonic DTS across appends
  // ("bufferAppendError" during playback). fMP4 with absolute tfdt (rewritten
  // in finalizeFmp4Segment) appends cleanly.
  return { codec, resolution, quality, speed, format: 'fmp4' };
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
    } catch {}
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
  } catch {
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
      try { fs.unlinkSync(probe); } catch {}
    }
  } catch {
    return [];
  }
}

/** Build ffmpeg arguments for transcoding a segment (or 1-frame init probe). */
function buildTranscodeArgs(seg, filePath, decodeArgs, enc, meta, opts) {
  const probeOnly = !!(opts && opts.probeOnly);
  // Hardware decode flags must come before the input they apply to
  const args = (decodeArgs || []).slice();
  args.push('-ss', String(seg.startTime), '-i', filePath);
  if (probeOnly) args.push('-frames:v', '1');
  else args.push('-t', String(seg.duration));

  // Primary video + optional primary audio only: drop embedded subtitles,
  // data streams and attached cover art that would crash -f mp4 muxing.
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  // Downscale on the short edge when requested (never upscale; portrait
  // 1080x1920 at "720p" scales to 720x1280 rather than 406x720). Even when
  // keeping original resolution, ensure even dimensions so 4:2:0 encoders
  // never reject odd-sized files.
  const enc_ = enc || { resolution: 0, quality: 23, speed: 'fast' };
  const isPortrait = !!(meta && meta.width > 0 && meta.height > 0 && meta.width < meta.height);
  if (enc_.resolution > 0) {
    args.push('-vf', isPortrait
      ? 'scale=' + enc_.resolution + ':-2'
      : 'scale=-2:' + enc_.resolution);
  } else if (meta && ((meta.width & 1) || (meta.height & 1))) {
    args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }

  // Always output browser-playable 8-bit 4:2:0 (prevents 10-bit / 4:2:2 /
  // 4:4:4 sources from failing NVENC H.264 or emitting unplayable profiles).
  args.push('-pix_fmt', 'yuv420p');

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
      '-profile:v', 'main',
      '-tag:v', 'hvc1'   // Apple-style tag, expected by browser decoders
    );
    if (preset) args.push('-preset', preset);
  } else if (ENCODER === 'h264_qsv') {
    args.push(
      '-global_quality', String(q),
      '-c:v', 'h264_qsv',
      '-profile:v', 'high'
    );
    if (preset) args.push('-preset', preset);
  } else if (ENCODER === 'h264_nvenc') {
    args.push(
      '-rc', 'vbr',
      '-cq', String(q),
      '-c:v', 'h264_nvenc',
      '-profile:v', 'high'
    );
    if (preset) args.push('-preset', preset);
  } else if (ENCODER === 'h264_amf') {
    args.push(
      '-rc', 'cqp',
      '-qp_i', String(q), '-qp_p', String(q),
      '-c:v', 'h264_amf',
      '-profile:v', 'high'
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
      '-c:v', 'libx264',
      '-profile:v', 'high'
    );
    if (preset) args.push('-preset', preset);
  }

  // Audio (downmix 5.1/7.1 to stereo 48 kHz for MSE compatibility & quality),
  // fixed 90 kHz video timescale (guarantees init.mp4 and every segment agree
  // and avoids 32-bit tfdt overflow on high-timescale MKV/MOV sources).
  args.push('-output_ts_offset', String(seg.startTime));
  args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a', '128k');
  if (enc_.format === 'fmp4') {
    // Fragmented MP4 (one fragment file per HLS segment; the moov init part
    // is served separately as init.mp4 — see _ensureInit).
    // -bf 0: B-frames would give the first frame a negative DTS, which makes
    //   the mp4 muxer rebase ALL timestamps to 0 — every segment would then
    //   claim to start at t=0 and MSE playback shows corrupted blocks.
    //   With B-frames off and -avoid_negative_ts disabled, -output_ts_offset
    //   survives into tfdt so segment N starts at N*6s.
    args.push(
      '-bf', '0',
      '-video_track_timescale', '90000',
      '-avoid_negative_ts', 'disabled',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4'
    );
  } else {
    args.push('-muxdelay', '0', '-f', 'mpegts');
  }
  args.push('-y', seg.outPath || seg.path);
  return args;
}

/**
 * Parse ISO-BMFF box structure: returns [{type, start, bodyStart, bodyEnd}]
 * for the boxes between start and end of the buffer.
 */
function walkBoxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size === 1) {
      // 64-bit size
      if (off + 16 > end) break;
      size = Number(buf.readBigUInt64BE(off + 8));
      if (size < 16) break;
    } else if (size === 0) {
      size = end - off; // box extends to end
    } else if (size < 8) {
      break;
    }
    if (off + size > end) break;
    out.push({ type, start: off, bodyStart: off + 8, bodyEnd: off + size });
    off += size;
  }
  return out;
}

// ─── Host filesystem mapping (Docker) ───────────────────────────────
// When the server runs in a container, the host filesystem is mounted at
// HOST_ROOT (e.g. /host) because mounting it over the container's own /
// would hide node/ffmpeg. With HOST_ROOT set, all client-facing paths stay
// exactly as on the host ('/media/movies/…') and are transparently mapped
// to /host/media/movies for filesystem access.
const HOST_ROOT = process.env.HOST_ROOT || '';

/** Client-facing path -> real filesystem path */
function toHostPath(p) {
  if (!HOST_ROOT) return p;
  return path.join(HOST_ROOT, p || '/');
}

/** Filesystem path -> client-facing path (strip the mount prefix) */
function fromHostPath(p) {
  if (!HOST_ROOT) return p;
  if (p === HOST_ROOT) return '/';
  if (p.startsWith(HOST_ROOT + '/')) return p.slice(HOST_ROOT.length);
  return p;
}

function safePath(rawPath) {
  let sp;
  try {
    sp = path.resolve(path.normalize(rawPath || ''));
  } catch {
    return null;
  }
  if (HOST_ROOT) {
    // Map onto the mounted host filesystem and refuse any traversal that
    // would escape it (e.g. /host/../)
    sp = path.resolve(HOST_ROOT, '.' + path.sep + sp.replace(/^([a-zA-Z]:)?[\\/]+/, ''));
    if (sp !== HOST_ROOT && !sp.startsWith(HOST_ROOT + path.sep)) return null;
  }
  if (!fs.existsSync(sp)) return null;
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

const AUDIO_EXT = new Set([
  '.mp3', '.flac', '.aac', '.ogg', '.oga', '.opus', '.m4a', '.wav', '.wma',
  '.aiff', '.aif', '.alac', '.ape', '.wv', '.dsf', '.dff', '.m4b', '.mka'
]);

function isVideo(file) {
  return VIDEO_EXT.has(path.extname(file).toLowerCase());
}

function isImage(file) {
  return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

function isAudio(file) {
  return AUDIO_EXT.has(path.extname(file).toLowerCase());
}

function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function streamRotation(videoStream) {
  if (!videoStream) return 0;
  if (videoStream.tags && videoStream.tags.rotate != null) {
    const r = parseFloat(videoStream.tags.rotate);
    if (Number.isFinite(r)) return r;
  }
  for (const sd of (videoStream.side_data_list || [])) {
    if (sd && sd.rotation != null) {
      const r = parseFloat(sd.rotation);
      if (Number.isFinite(r)) return r;
    }
  }
  return 0;
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
    const proc = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let data = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      done(new Error('ffprobe timed out'));
    }, 15000);
    proc.stdout.on('data', (chunk) => { data += chunk; });
    proc.on('close', (code) => {
      if (code !== 0) return done(new Error('ffprobe failed'));
      try {
        const info = JSON.parse(data);
        const allStreams = info.streams || [];
        // Prefer real video stream over embedded album/cover art (attached_pic)
        const videoStream = allStreams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
          || allStreams.find(s => s.codec_type === 'video');
        const audioStream = allStreams.find(s => s.codec_type === 'audio');
        const rawW = videoStream ? (videoStream.width || 0) : 0;
        const rawH = videoStream ? (videoStream.height || 0) : 0;
        const rotated = Math.abs(Math.round(streamRotation(videoStream))) % 180 === 90;
        const duration = parseFloat((info.format && info.format.duration) || 0)
          || parseFloat((videoStream && videoStream.duration) || 0)
          || parseFloat((audioStream && audioStream.duration) || 0)
          || 0;
        done(null, {
          duration,
          size: info.format ? parseInt(info.format.size || 0) : 0,
          bitrate: info.format ? parseInt(info.format.bit_rate || 0) : 0,
          width: rotated ? rawH : rawW,
          height: rotated ? rawW : rawH,
          codec: videoStream ? videoStream.codec_name : '',
          pixFmt: videoStream ? (videoStream.pix_fmt || '') : '',
          audioCodec: audioStream ? audioStream.codec_name : '',
          fps: videoStream ? evalFps(videoStream.r_frame_rate) : 0,
        });
      } catch (e) {
        done(e);
      }
    });
    proc.on('error', (err) => done(err));
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
const castStreams = new Map(); // receiverUrl -> active HLS streamId
const SEGMENT_DURATION = 6;
const MIN_TAIL_SEGMENT = 0.5;  // fold trailing <0.5s tail into previous segment
const PIPELINE_LOOKAHEAD = 20; // keep at most ~2 min transcoded ahead of playback
const TRANSCODE_CONCURRENCY = Math.max(1, parseInt(process.env.TRANSCODE_CONCURRENCY || '2', 10) || 2);
const TRANSCODE_TIMEOUT_MS = 45000;

// ─── Priority transcode scheduler ────────────────────────────────────────────
// Caps concurrent ffmpeg transcodes globally so scrubbing/switching never blows
// NVENC's concurrent session limit (which falsely triggers software fallback).
// High priority (on-demand client seeks / init) always runs before background
// prefetch.
let transcodeRunning = 0;
const transcodeHighQ = [];
const transcodeLowQ = [];

function withTranscodeSlot(highPriority, fn) {
  return new Promise((resolve) => {
    const run = () => {
      transcodeRunning++;
      Promise.resolve()
        .then(fn)
        .then(resolve, () => resolve(false))
        .finally(() => {
          transcodeRunning--;
          const next = transcodeHighQ.shift() || transcodeLowQ.shift();
          if (next) next();
        });
    };
    if (transcodeRunning < TRANSCODE_CONCURRENCY) run();
    else if (highPriority) transcodeHighQ.push(run);
    else transcodeLowQ.push(run);
  });
}

/**
 * Spawn ffmpeg with non-blocking stderr draining (prevents 64 KB pipe buffer
 * deadlock on noisy/corrupt files), process tracking, and a watchdog timeout.
 */
function runFfmpegManaged(args, procs, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    procs.add(proc);
    let stderrTail = '';
    let settled = false;
    const finish = (code, errMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      procs.delete(proc);
      resolve({ code, stderr: errMsg || stderrTail.trim() });
    };
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      finish(-1, 'ffmpeg timed out');
    }, timeoutMs || TRANSCODE_TIMEOUT_MS);
    if (proc.stderr) {
      proc.stderr.on('data', (chunk) => {
        stderrTail += chunk.toString('utf8');
        if (stderrTail.length > 2048) stderrTail = stderrTail.slice(-2048);
      });
    }
    proc.on('close', (code) => finish(code));
    proc.on('error', (err) => finish(-1, err.message));
  });
}

/** Atomically write `data` to `dest` via a sibling temp file. */
function atomicWriteFile(dest, data) {
  const tmp = dest + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

/** Build the segment table, folding a tiny (<0.5s) trailing sliver into the previous segment. */
function buildSegmentTable(duration, cacheDir, format) {
  const ext = format === 'fmp4' ? '.m4s' : '.ts';
  const segs = [];
  let totalSegs = Math.max(1, Math.ceil(duration / SEGMENT_DURATION));
  if (totalSegs > 1) {
    const tail = duration - (totalSegs - 1) * SEGMENT_DURATION;
    if (tail < MIN_TAIL_SEGMENT) totalSegs--;
  }
  for (let i = 0; i < totalSegs; i++) {
    const startTime = i * SEGMENT_DURATION;
    const dur = (i === totalSegs - 1)
      ? Math.max(0.1, duration - startTime)
      : SEGMENT_DURATION;
    segs.push({
      index: i,
      startTime,
      duration: dur,
      cached: false,
      transcoding: false,
      path: path.join(cacheDir, 'seg-' + i + ext),
      outPath: path.join(cacheDir, 'seg-' + i + '.tmp' + ext),
      queue: [],
    });
  }
  return segs;
}

class VideoStream {
  constructor(id, filePath, encOptions, startSec) {
    this.id = id;
    this.filePath = filePath;
    this.encOptions = encOptions ||
      { codec: 'h264', resolution: 0, quality: 23, speed: 'fast', format: 'fmp4' };
    this.startSec = Math.max(0, Number(startSec) || 0);
    this.segments = [];
    this.metadata = null;
    this.cleaned = false;
    this.cacheDir = path.join(CACHE_DIR, id);
    this._activeIndex = 0;        // highest / most recent segment requested by client
    this._pipelineIndex = 0;      // next segment to transcode in background
    this._pipelineActive = false; // whether background pipeline loop is running
    this._pipelineTarget = null;  // seek refocus: pipeline jumps here when it can
    this.decodeArgs = [];         // hw decode flags for this stream (set in init)
    this.initPath = path.join(this.cacheDir, 'init.mp4'); // fMP4 init segment
    this._initPromise = null;     // in-flight init generation
    this._procs = new Set();      // live ffmpeg ChildProcess instances
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async init() {
    this.metadata = await getVideoMetadata(this.filePath);
    if (!this.metadata.duration || this.metadata.duration <= 0) {
      throw new Error('Could not determine video duration');
    }
    // Never upscale: compare requested resolution against the video's short edge
    const shortEdge = (this.metadata.width && this.metadata.height)
      ? Math.min(this.metadata.width, this.metadata.height)
      : (this.metadata.height || 0);
    if (this.encOptions.resolution > 0 && shortEdge && shortEdge <= this.encOptions.resolution) {
      this.encOptions.resolution = 0;
    }
    // Use GPU decoding only for codecs NVDEC supports (others use software decode)
    this.decodeArgs = (DECODE_ARGS.length && NVDEC_CODECS.has(this.metadata.codec))
      ? DECODE_ARGS.slice()
      : [];
    this.segments = buildSegmentTable(this.metadata.duration, this.cacheDir, this.encOptions.format);

    // Start pre-transcoding right at the resume/start timestamp instead of
    // wasting GPU time on segment 0 when resuming mid-video.
    const startIdx = Math.min(
      this.segments.length - 1,
      Math.max(0, Math.floor(this.startSec / SEGMENT_DURATION))
    );
    this._activeIndex = startIdx;
    if (this.segments[startIdx]) this._startTranscode(startIdx, true);
    if (this.segments[startIdx + 1]) this._startTranscode(startIdx + 1, true);
    this._pipelineIndex = startIdx + 2;
    this._kickPipeline();
  }

  getPlaylist() {
    if (!this.metadata || !this.segments.length) return null;
    const isFmp4 = this.encOptions.format === 'fmp4';
    const maxDur = this.segments.reduce((m, s) => Math.max(m, s.duration), SEGMENT_DURATION);
    const lines = [
      '#EXTM3U',
      // RFC 8216: EXT-X-MAP with fMP4 segments requires version >= 7
      '#EXT-X-VERSION:' + (isFmp4 ? 7 : 3),
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:' + Math.ceil(maxDur),
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    if (isFmp4) lines.push('#EXT-X-MAP:URI="init.mp4"');
    const ext = isFmp4 ? '.m4s' : '.ts';
    for (const seg of this.segments) {
      lines.push('#EXTINF:' + seg.duration.toFixed(3) + ',');
      lines.push('segment-' + seg.index + ext);
    }
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\r\n');
  }

  /**
   * Ensure a client-requested segment is transcoded (high priority).
   * Advances the lookahead window and wakes the background pipeline.
   */
  ensureSegment(index) {
    if (this.cleaned || index < 0 || index >= this.segments.length) return Promise.resolve(false);
    const seg = this.segments[index];
    const jumped = Math.abs(index - this._activeIndex) > 3;
    this._activeIndex = index;
    if (jumped || Math.abs(index - this._pipelineIndex) > 3) {
      this._pipelineTarget = index + 1;
    }
    this._kickPipeline();
    if (seg.cached) return Promise.resolve(true);
    if (seg.transcoding) {
      return new Promise((resolve) => { seg.queue.push(resolve); });
    }
    return this._startTranscode(index, true);
  }

  /**
   * Strip leading ftyp+moov (caching it to init.mp4 if not yet present),
   * rewrite tfdt to the segment's absolute start time, and atomically move
   * the finalized media segment into place. Returns true on success.
   */
  finalizeFmp4Segment(tmpFile, finalFile, startSec) {
    try {
      const buf = fs.readFileSync(tmpFile);
      const top = walkBoxes(buf, 0, buf.length);
      const firstMoof = top.find(b => b.type === 'moof');
      if (!firstMoof) return false;

      // Reuse the embedded ftyp+moov as init.mp4 (guarantees matching codec
      // config & timescale and avoids spawning an extra ffmpeg probe).
      if (firstMoof.start > 0 && !fs.existsSync(this.initPath)) {
        atomicWriteFile(this.initPath, buf.subarray(0, firstMoof.start));
      }

      // Track map from the embedded moov: track_ID -> timescale
      const timescales = {};
      const moov = top.find(b => b.type === 'moov');
      if (moov) {
        for (const trak of walkBoxes(buf, moov.bodyStart, moov.bodyEnd)) {
          if (trak.type !== 'trak') continue;
          const trakKids = walkBoxes(buf, trak.bodyStart, trak.bodyEnd);
          const tkhd = trakKids.find(b => b.type === 'tkhd');
          const mdia = trakKids.find(b => b.type === 'mdia');
          if (!tkhd || !mdia) continue;
          const mdhd = walkBoxes(buf, mdia.bodyStart, mdia.bodyEnd).find(b => b.type === 'mdhd');
          if (!mdhd) continue;
          const trackId = buf.readUInt32BE(tkhd.bodyStart + 4 + (buf[tkhd.bodyStart] === 1 ? 16 : 8));
          const ver = buf[mdhd.bodyStart];
          const ts = buf.readUInt32BE(mdhd.bodyStart + 4 + (ver === 1 ? 16 : 8));
          timescales[trackId] = ts;
        }
      }

      const moofs = top.filter(b => b.type === 'moof');
      const firstTfdt = {};
      for (const moof of moofs) {
        for (const traf of walkBoxes(buf, moof.bodyStart, moof.bodyEnd)) {
          if (traf.type !== 'traf') continue;
          const boxes = walkBoxes(buf, traf.bodyStart, traf.bodyEnd);
          const tfhd = boxes.find(b => b.type === 'tfhd');
          const tfdt = boxes.find(b => b.type === 'tfdt');
          if (!tfhd || !tfdt) continue;
          const trackId = buf.readUInt32BE(tfhd.bodyStart + 4);
          if (!(trackId in firstTfdt)) {
            const ver = buf[tfdt.bodyStart];
            firstTfdt[trackId] = ver === 1
              ? Number(buf.readBigUInt64BE(tfdt.bodyStart + 4))
              : buf.readUInt32BE(tfdt.bodyStart + 4);
          }
        }
      }

      for (const moof of moofs) {
        for (const traf of walkBoxes(buf, moof.bodyStart, moof.bodyEnd)) {
          if (traf.type !== 'traf') continue;
          const boxes = walkBoxes(buf, traf.bodyStart, traf.bodyEnd);
          const tfhd = boxes.find(b => b.type === 'tfhd');
          const tfdt = boxes.find(b => b.type === 'tfdt');
          if (!tfhd || !tfdt) continue;
          const trackId = buf.readUInt32BE(tfhd.bodyStart + 4);
          const ts = timescales[trackId];
          if (!ts) continue;
          const ver = buf[tfdt.bodyStart];
          const cur = ver === 1
            ? Number(buf.readBigUInt64BE(tfdt.bodyStart + 4))
            : buf.readUInt32BE(tfdt.bodyStart + 4);
          const shift = Math.round(startSec * ts) - firstTfdt[trackId];
          const next = Math.max(0, cur + shift);
          if (ver === 1) {
            buf.writeBigUInt64BE(BigInt(next), tfdt.bodyStart + 4);
          } else if (next <= 0xffffffff) {
            buf.writeUInt32BE(next, tfdt.bodyStart + 4);
          }
        }
      }

      const written = atomicWriteFile(finalFile, buf.subarray(firstMoof.start));
      try { fs.unlinkSync(tmpFile); } catch {}
      return written;
    } catch (e) {
      console.error('[finalize] failed for ' + finalFile + ':', e.message);
      try { fs.unlinkSync(tmpFile); } catch {}
      return false;
    }
  }

  /**
   * fMP4 init segment (codec headers only). Usually populated for free by the
   * first finalized media segment; if requested before any segment finishes,
   * encodes a single-frame probe (with software-decode fallback).
   */
  _ensureInit() {
    if (this.cleaned) return Promise.resolve(false);
    if (fs.existsSync(this.initPath)) return Promise.resolve(true);
    if (this._initPromise) return this._initPromise;
    this._initPromise = withTranscodeSlot(true, async () => {
      if (this.cleaned) return false;
      if (fs.existsSync(this.initPath)) return true;
      const probe = path.join(this.cacheDir, 'probe.mp4');
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.cleaned) return false;
        const usedHw = this.decodeArgs.length > 0;
        const args = buildTranscodeArgs(
          { startTime: 0, duration: 1, outPath: probe },
          this.filePath, this.decodeArgs, this.encOptions, this.metadata,
          { probeOnly: true }
        );
        const { code } = await runFfmpegManaged(args, this._procs, 20000);
        if (code === 0 && fs.existsSync(probe)) {
          try {
            const buf = fs.readFileSync(probe);
            const firstMoof = walkBoxes(buf, 0, buf.length).find(b => b.type === 'moof');
            try { fs.unlinkSync(probe); } catch {}
            if (firstMoof && firstMoof.start > 0) {
              return atomicWriteFile(this.initPath, buf.subarray(0, firstMoof.start));
            }
          } catch {
            try { fs.unlinkSync(probe); } catch {}
          }
        } else {
          try { fs.unlinkSync(probe); } catch {}
        }
        if (usedHw && !this.cleaned) {
          this.decodeArgs = [];
          console.warn('Hardware decode failed on init probe for "' +
            path.basename(this.filePath) + '", retrying with software decoding');
          continue;
        }
        break;
      }
      return fs.existsSync(this.initPath);
    }).finally(() => { this._initPromise = null; });
    return this._initPromise;
  }

  /** Notify and drain all promises waiting on `seg`. */
  _notifyWaiters(seg, ok) {
    const waiters = seg.queue;
    seg.queue = [];
    for (const fn of waiters) fn(ok);
  }

  /** Internal: launch ffmpeg for a segment through the priority pool. */
  _startTranscode(index, highPriority) {
    const seg = this.segments[index];
    if (!seg || this.cleaned) return Promise.resolve(false);
    if (seg.cached) return Promise.resolve(true);
    if (seg.transcoding) {
      return new Promise((resolve) => { seg.queue.push(resolve); });
    }
    seg.transcoding = true;

    const run = async () => {
      if (this.cleaned) {
        seg.transcoding = false;
        this._notifyWaiters(seg, false);
        return false;
      }
      const usedHw = this.decodeArgs.length > 0;
      const args = buildTranscodeArgs(seg, this.filePath, this.decodeArgs, this.encOptions, this.metadata);
      const { code, stderr } = await runFfmpegManaged(args, this._procs, TRANSCODE_TIMEOUT_MS);
      if (this.cleaned) {
        try { fs.unlinkSync(seg.outPath); } catch {}
        seg.transcoding = false;
        this._notifyWaiters(seg, false);
        return false;
      }

      let ok = (code === 0 && fs.existsSync(seg.outPath) && fs.statSync(seg.outPath).size > 0);
      if (ok) {
        if (this.encOptions.format === 'fmp4') {
          ok = this.finalizeFmp4Segment(seg.outPath, seg.path, seg.startTime);
        } else {
          try { fs.renameSync(seg.outPath, seg.path); } catch { ok = false; }
        }
      }

      if (ok) {
        seg.cached = true;
        seg.transcoding = false;
        this._notifyWaiters(seg, true);
        return true;
      }

      try { fs.unlinkSync(seg.outPath); } catch {}
      try { fs.unlinkSync(seg.path); } catch {}

      // Hardware decode failed — disable for the stream and retry once on CPU
      if (usedHw && !this.cleaned) {
        this.decodeArgs = [];
        console.warn('Hardware decode failed for "' + path.basename(this.filePath) +
          '", falling back to software decoding');
        const retryArgs = buildTranscodeArgs(seg, this.filePath, [], this.encOptions, this.metadata);
        const retry = await runFfmpegManaged(retryArgs, this._procs, TRANSCODE_TIMEOUT_MS);
        let ok2 = !this.cleaned && retry.code === 0 &&
          fs.existsSync(seg.outPath) && fs.statSync(seg.outPath).size > 0;
        if (ok2) {
          if (this.encOptions.format === 'fmp4') {
            ok2 = this.finalizeFmp4Segment(seg.outPath, seg.path, seg.startTime);
          } else {
            try { fs.renameSync(seg.outPath, seg.path); } catch { ok2 = false; }
          }
        }
        if (ok2) {
          seg.cached = true;
          seg.transcoding = false;
          this._notifyWaiters(seg, true);
          return true;
        }
        try { fs.unlinkSync(seg.outPath); } catch {}
        try { fs.unlinkSync(seg.path); } catch {}
        if (retry.stderr) console.error('[transcode seg ' + index + '] ' + retry.stderr.split('\n').pop());
      } else if (stderr) {
        console.error('[transcode seg ' + index + '] ' + stderr.split('\n').pop());
      }

      seg.transcoding = false;
      this._notifyWaiters(seg, false);
      return false;
    };

    return withTranscodeSlot(!!highPriority, run);
  }

  /** Start/wake the background lookahead pipeline if not already running. */
  _kickPipeline() {
    if (this.cleaned || this._pipelineActive) return;
    this._pipelineActive = true;
    setImmediate(() => this._runPipeline());
  }

  /**
   * Background pipeline: pre-transcode up to PIPELINE_LOOKAHEAD segments ahead
   * of `_activeIndex`. Pauses automatically when the window is full so paused
   * videos never burn GPU or fill /tmp, and resumes when playback advances.
   */
  async _runPipeline() {
    if (this.cleaned || !this._pipelineActive) return;
    if (this._pipelineTarget != null) {
      this._pipelineIndex = this._pipelineTarget;
      this._pipelineTarget = null;
    }
    const windowEnd = Math.min(this.segments.length, this._activeIndex + PIPELINE_LOOKAHEAD);
    while (this._pipelineIndex < windowEnd) {
      const seg = this.segments[this._pipelineIndex];
      if (!seg.cached && !seg.transcoding) break;
      this._pipelineIndex++;
    }
    if (this._pipelineIndex >= windowEnd) {
      this._pipelineActive = false;
      return;
    }
    const idx = this._pipelineIndex;
    this._pipelineIndex++;
    await this._startTranscode(idx, false);
    if (!this.cleaned && this._pipelineActive) {
      setImmediate(() => this._runPipeline());
    }
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this._pipelineActive = false;
    clearTimeout(this.cleanupTimer);
    for (const proc of this._procs) {
      try { proc.kill('SIGKILL'); } catch {}
    }
    this._procs.clear();
    for (const seg of this.segments) {
      seg.transcoding = false;
      this._notifyWaiters(seg, false);
    }
    try {
      fs.rmSync(this.cacheDir, { recursive: true, force: true });
    } catch {}
  }
}

app.get('/api/drives', (_req, res) => {
  if (process.platform === 'win32') {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const drivePath = letter + '\\';
      try {
        if (fs.existsSync(drivePath)) {
          drives.push({ name: drivePath, path: drivePath });
        }
      } catch {}
    }
    return res.json(drives);
  } else {
    const roots = [fromHostPath(HOST_ROOT || '/')];
    for (const dir of ['/mnt', '/media']) {
      const hostDir = toHostPath(dir);
      try {
        if (fs.existsSync(hostDir)) {
          const items = fs.readdirSync(hostDir);
          for (const item of items) {
            const p = path.join(dir, item);
            try {
              if (fs.statSync(toHostPath(p)).isDirectory()) roots.push(p);
            } catch {}
          }
        }
      } catch {}
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
      try { stat = fs.statSync(fullPath); } catch { continue; }
      result.push({
        name: dirent.name,
        path: fromHostPath(fullPath),
        isDirectory: dirent.isDirectory(),
        isVideo: isVideo(dirent.name),
        isImage: isImage(dirent.name),
        isAudio: isAudio(dirent.name),
        size: stat.size,
        sizeFormatted: formatSize(stat.size),
        mtime: stat.mtime
      });
    }
    result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    // Parent: never go above the mount root when HOST_ROOT is set
    const dirHost = path.dirname(sp);
    const parent = (HOST_ROOT && dirHost !== HOST_ROOT && !dirHost.startsWith(HOST_ROOT + path.sep))
      ? fromHostPath(HOST_ROOT)
      : fromHostPath(dirHost);
    res.json({ path: fromHostPath(sp), parent, contents: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Home menu favorites (stored in data/home.json) ─────────────────────
const HOME_FILE = path.join(__dirname, 'data', 'home.json');
const HOME_DEFAULT_FOLDERS = ['/mnt', '/media'];

function loadHomeFolders() {
  try {
    const data = JSON.parse(fs.readFileSync(HOME_FILE, 'utf8'));
    if (data && Array.isArray(data.folders)) {
      return data.folders.filter((f) => typeof f === 'string' && f.trim());
    }
  } catch { /* first run or unreadable file */ }
  return null;
}

function saveHomeFolders(folders) {
  fs.mkdirSync(path.dirname(HOME_FILE), { recursive: true });
  fs.writeFileSync(HOME_FILE, JSON.stringify({ folders }, null, 2));
}

app.get('/api/home/folders', (_req, res) => {
  let folders = loadHomeFolders();
  if (!folders) {
    folders = HOME_DEFAULT_FOLDERS.slice();
    try { saveHomeFolders(folders); } catch (e) { console.warn('home.json: ' + e.message); }
  }
  res.json({ folders });
});

/** Add a favorite folder. The path must exist and be a directory. */
app.post('/api/home/folders', (req, res) => {
  const raw = String((req.body && req.body.path) || '').trim();
  if (!raw) return res.status(400).json({ error: 'Path required' });
  // safePath resolves + guards traversal, and requires the path to exist
  const sp = safePath(raw);
  if (!sp) return res.status(400).json({ error: 'Folder not found: ' + raw });
  try {
    if (!fs.statSync(sp).isDirectory()) {
      return res.status(400).json({ error: 'Not a folder: ' + raw });
    }
  } catch {
    return res.status(400).json({ error: 'Folder not found: ' + raw });
  }
  const clientPath = fromHostPath(sp);
  const folders = loadHomeFolders() || HOME_DEFAULT_FOLDERS.slice();
  if (!folders.includes(clientPath)) folders.push(clientPath);
  try {
    saveHomeFolders(folders);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ folders });
});

/** Remove a favorite folder (unknown paths are ignored — idempotent). */
app.delete('/api/home/folders', (req, res) => {
  const raw = String(req.query.path || '').trim();
  const folders = (loadHomeFolders() || HOME_DEFAULT_FOLDERS.slice())
    .filter((f) => f !== raw);
  try {
    saveHomeFolders(folders);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ folders });
});

// ─── Folder zip download & delete ───────────────────────────────────────
const archiver = require('archiver');

/** Stream a folder as a ZIP file. Content-Disposition names it after the folder. */
app.get('/api/download/zip', (req, res) => {
  const sp = safePath(req.query.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  try {
    if (!fs.statSync(sp).isDirectory()) {
      return res.status(400).json({ error: 'Not a folder' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const base = path.basename(sp) || 'folder';
  res.set({
    'Content-Type': 'application/zip',
    'Cache-Control': 'no-cache',
    // ASCII fallback + RFC 5987 for non-ASCII folder names
    'Content-Disposition': 'attachment; filename="' +
      base.replace(/[^\x20-\x7e]/g, '_') + '.zip"; filename*=UTF-8\'\'' +
      encodeURIComponent(base) + '.zip',
  });
  // Media files barely compress — lowest deflate level keeps CPU and latency low
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (err) => {
    console.error('[zip] failed for ' + sp + ':', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  });
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.warn('[zip] ' + err.message);
  });
  archive.pipe(res);
  // Folder itself as the zip root (extracts into a named directory)
  archive.directory(sp, base);
  archive.finalize();
});

/** Delete a folder and everything inside it. */
app.delete('/api/folder', (req, res) => {
  const sp = safePath(req.query.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  // Refuse to delete filesystem / mount roots
  if (sp === path.parse(sp).root || (HOST_ROOT && sp === HOST_ROOT)) {
    return res.status(400).json({ error: 'Refusing to delete a root' });
  }
  try {
    if (!fs.statSync(sp).isDirectory()) {
      return res.status(400).json({ error: 'Not a folder' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid path' });
  }
  try {
    fs.rmSync(sp, { recursive: true, force: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
});

app.get('/api/video/raw', (req, res) => {
  const sp = safePath(req.query.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  // sendFile supports HTTP Range requests, so external players / browsers can seek
  res.sendFile(sp, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
});

// ─── Thumbnails (gallery views) ──────────────────────────────────────────
// Rendered live with ffmpeg and kept **in memory only** (never written to
// disk): a folder view re-renders its tiles after a restart, and nothing goes
// stale when a file is replaced. ffmpeg is expensive, so renders are capped at
// THUMB_CONCURRENCY at a time and identical requests share one render.
const THUMB_WIDTH = 480;
const THUMB_CONCURRENCY = 2;
const THUMB_MEM_LIMIT = 64 * 1024 * 1024; // 64 MB of JPEGs, oldest evicted first

let thumbRunning = 0;
const thumbWaiting = [];
const thumbJobs = new Map();
const thumbMemory = new Map();   // cache key -> Buffer (Map keeps insertion order)
let thumbMemBytes = 0;

function thumbCacheGet(key) {
  const buf = thumbMemory.get(key);
  if (!buf) return null;
  // Re-insert so the newest reads sit at the end and are evicted last
  thumbMemory.delete(key);
  thumbMemory.set(key, buf);
  return buf;
}

function thumbCachePut(key, buf) {
  if (buf.length > THUMB_MEM_LIMIT / 4) return; // one tile never owns the budget
  if (thumbMemory.has(key)) thumbMemBytes -= thumbMemory.get(key).length;
  thumbMemory.set(key, buf);
  thumbMemBytes += buf.length;
  while (thumbMemBytes > THUMB_MEM_LIMIT) {
    const oldest = thumbMemory.keys().next();
    if (oldest.done) break;
    thumbMemBytes -= thumbMemory.get(oldest.value).length;
    thumbMemory.delete(oldest.value);
  }
}

/** Run `fn` with at most THUMB_CONCURRENCY ffmpeg processes at a time. */
function withThumbSlot(fn) {
  return new Promise((resolve) => {
    const run = () => {
      thumbRunning++;
      fn().then(resolve, () => resolve(null)).finally(() => {
        thumbRunning--;
        const next = thumbWaiting.shift();
        if (next) next();
      });
    };
    if (thumbRunning < THUMB_CONCURRENCY) run();
    else thumbWaiting.push(run);
  });
}

/** Render one JPEG frame of `file` into memory; resolves to null on failure. */
function renderThumbBuffer(file, seek) {
  return new Promise((resolve) => {
    const args = [];
    if (seek) args.push('-ss', String(seek));
    args.push(
      '-v', 'error',
      '-i', file,
      '-frames:v', '1',
      // Never upscale; keep the aspect ratio (cards crop with object-fit)
      '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`,
      '-q:v', '6',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1'
    );
    const proc = spawn(FFMPEG, args);
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { proc.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });
  });
}

async function makeThumb(sp, key, wantsSeek) {
  const cached = thumbCacheGet(key);
  if (cached) return cached;
  // A frame a little into the video beats a black first frame; very short
  // clips fall back to frame 0.
  let buf = wantsSeek ? await renderThumbBuffer(sp, 2) : await renderThumbBuffer(sp, 0);
  if (!buf && wantsSeek) buf = await renderThumbBuffer(sp, 0);
  if (buf) thumbCachePut(key, buf);
  return buf;
}

app.get('/api/thumb', async (req, res) => {
  const sp = safePath(req.query.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  if (!FFMPEG) return res.status(500).json({ error: 'ffmpeg not found' });
  let stat;
  try { stat = fs.statSync(sp); } catch { return res.status(404).json({ error: 'Not found' }); }
  if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });

  // Key on path + mtime + size, so a replaced file gets a fresh render
  const key = `${sp}|${stat.mtimeMs}|${stat.size}`;

  let job = thumbJobs.get(key);
  if (!job) {
    job = withThumbSlot(() => makeThumb(sp, key, isVideo(sp)));
    thumbJobs.set(key, job);
    job.finally(() => thumbJobs.delete(key));
  }
  const buf = await job;
  if (!buf) return res.status(404).json({ error: 'No thumbnail' });
  // Memory-only: tell the browser not to keep its own copy either
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
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
    const stream = await startStreamSession(sp, req.query);
    res.json({
      streamId: stream.id,
      duration: stream.metadata.duration,
      width: stream.metadata.width,
      height: stream.metadata.height,
      codec: stream.metadata.codec,
      activeCodec: stream.encOptions.codec,
      resolution: stream.encOptions.resolution,
      fps: stream.metadata.fps,
      segments: stream.segments.length,
      playlistUrl: '/api/video/stream/' + stream.id + '/playlist.m3u8'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Create a transcoding session for a file (shared by player + cast flows). */
async function startStreamSession(sp, query) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const encOptions = parseEncOptions(query || {});
  const startSec = parseFloat(query && query.start) || 0;
  const stream = new VideoStream(id, sp, encOptions, startSec);
  try {
    await stream.init();
  } catch (err) {
    stream.cleanup();
    throw err;
  }
  streams.set(id, stream);
  touchStream(id);
  return stream;
}

/** Destroy a stream session immediately, killing its ffmpeg processes and deleting temp files. */
function destroyStream(streamId) {
  const cur = streams.get(streamId);
  if (!cur) return false;
  streams.delete(streamId);
  cur.cleanup();
  return true;
}

/** Reset the idle-expiry timer for a stream session (client is active). */
function touchStream(streamId) {
  const s = streams.get(streamId);
  if (!s) return;
  clearTimeout(s.cleanupTimer);
  s.cleanupTimer = setTimeout(() => destroyStream(streamId), 5 * 60 * 1000);
}

app.delete('/api/video/stream/:id', (req, res) => {
  res.json({ ok: destroyStream(req.params.id) });
});

// POST variant so browsers can tear down sessions via navigator.sendBeacon() on tab close
app.post('/api/video/stream/:id/stop', (req, res) => {
  res.json({ ok: destroyStream(req.params.id) });
});

app.get('/api/video/stream/:id/playlist.m3u8', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  touchStream(req.params.id);
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
  serveStreamInit(stream, res);
});

async function serveSegment(req, res) {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const index = parseInt(req.params.index);
  if (isNaN(index)) return res.status(400).json({ error: 'Invalid segment index' });
  await serveStreamSegment(stream, index, res);
}

async function serveStreamSegment(stream, index, res) {
  if (stream.cleaned) return res.status(404).json({ error: 'Stream closed' });
  touchStream(stream.id); // client is actively fetching — keep session alive
  const ok = await stream.ensureSegment(index);
  if (stream.cleaned || res.writableEnded) return;
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
  res.sendFile(segPath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

async function serveStreamInit(stream, res) {
  if (stream.cleaned) return res.status(404).json({ error: 'Stream closed' });
  if (stream.encOptions.format !== 'fmp4') return res.status(404).json({ error: 'Not an fMP4 stream' });
  touchStream(stream.id);
  const ok = await stream._ensureInit();
  if (stream.cleaned || res.writableEnded) return;
  if (!ok || !fs.existsSync(stream.initPath)) return res.status(500).json({ error: 'Failed to generate init segment' });
  res.set({
    'Content-Type': 'video/mp4',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*'
  });
  res.sendFile(stream.initPath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
}

app.get('/api/video/stream/:id/status', (req, res) => {
  const stream = streams.get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  touchStream(req.params.id);
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

// ─── Cast-friendly URLs (used when casting to a Castor receiver) ──────────
//   /api/video/cast/<name>       → original file, Range-supported (?path=…)
//   /api/video/cast/<name>.m3u8  → HLS playlist of a running session (?session=…)
// The pretty last path segment becomes the receiver's display title; for HLS
// the explicit `title` sent with the cast overrides it anyway.
app.get('/api/video/cast/:name', (req, res) => {
  const name = String(req.params.name || '');
  const stream = streams.get(String(req.query.session || ''));
  // Stream parts: the playlist references segments relatively, and relative
  // URL resolution drops the base's ?session= query — so this route serves
  // seg-N.m4s / seg-N.ts / init.mp4 for a running session as well.
  const segMatch = name.match(/^segment-(\d+)\.(m4s|ts)$/);
  if (segMatch) {
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    return serveStreamSegment(stream, parseInt(segMatch[1]), res);
  }
  if (name === 'init.mp4') {
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    return serveStreamInit(stream, res);
  }
  if (name.toLowerCase().endsWith('.m3u8')) {
    if (!stream) return res.status(404).json({ error: 'Stream not found' });
    touchStream(stream.id);
    const playlist = stream.getPlaylist();
    if (!playlist) return res.status(500).json({ error: 'Failed to generate playlist' });
    // Stamp every referenced part with the session id: hls.js resolves the
    // playlist's relative URIs WITHOUT the playlist URL's query string.
    const stamped = playlist
      .replace(/(segment-\d+\.(?:m4s|ts))/g, '$1?session=' + stream.id)
      .replace(/(init\.mp4)/g, '$1?session=' + stream.id);
    res.set({
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    return res.send(stamped);
  }
  const sp = safePath(req.query.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  // sendFile supports HTTP Range requests so the receiver can seek
  res.sendFile(sp, (err) => {
    if (err && !res.headersSent) res.status(500).json({ error: err.message });
  });
});

// ═══ Castor receivers (cast-to-TV targets) ════════════════════════════════
// Castor (github repo: Castor) is the user's LAN playback receiver. It
// exposes POST /api/cast {module, target} on port 8642. Two cast modes:
// - local   → receiver runs on the same host as this server (e.g. the Docker
//             host): it gets the file PATH and reads it directly. The
//             client-facing path already matches the host filesystem because
//             the HOST_ROOT mount prefix is stripped, so Castor's `local`
//             module finds the file (and transcodes via CASTOR_FILESERVER
//             if the format needs it).
// - remote  → receiver on another device: it gets an http(s) URL served by
//             this server. Browser-compatible files stream as the original
//             file (`direct`); everything else is transcoded to HLS via the
//             session API above (Castor plays .m3u8 through hls.js).

const castorMdns = require('./castor-mdns');
const CASTOR_FILE = path.join(__dirname, 'data', 'castor-receivers.json');
let castorSaved = [];
try { castorSaved = JSON.parse(fs.readFileSync(CASTOR_FILE, 'utf8')); } catch { /* first run */ }
if (!Array.isArray(castorSaved)) castorSaved = [];

function saveCastorReceivers() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(CASTOR_FILE, JSON.stringify(castorSaved, null, 2));
}

let castorBrowseCache = { at: 0, list: [] };
async function castorDiscovered() {
  if (Date.now() - castorBrowseCache.at < 5000) return castorBrowseCache.list;
  try {
    castorBrowseCache = { at: Date.now(), list: await castorMdns.browse(2500) };
  } catch (err) {
    console.warn('Castor mDNS browse failed: ' + err.message);
    castorBrowseCache = { at: Date.now(), list: [] };
  }
  return castorBrowseCache.list;
}

function normalizeReceiverUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) return null;
  try { if (!new URL(s).hostname) return null; } catch { return null; }
  return s;
}

async function probeReceiver(url) {
  try {
    const r = await fetch(url + '/api/info', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const info = await r.json();
    return { name: info.name || 'Castor receiver', state: info.state || null };
  } catch {
    return null;
  }
}

/** Resolve the cast target receiver from receiverId / receiverUrl (+ overrides). */
function resolveReceiver(q) {
  if (q.receiverId != null && q.receiverId !== '') {
    const found = castorSaved.find(r => String(r.id) === String(q.receiverId));
    if (found) return q.mode ? { ...found, mode: q.mode } : found;
  }
  const url = normalizeReceiverUrl(q.receiverUrl);
  if (!url) return null;
  const found = castorSaved.find(r => r.url === url);
  if (found) return q.mode ? { ...found, mode: q.mode } : found;
  return {
    id: null,
    url,
    name: String(q.receiverName || url),
    mode: q.mode === 'local' ? 'local' : 'remote',
    pin: String(q.pin || ''),
  };
}

// Containers Chromium cannot decode natively (mirrors Castor's decideSource);
// these always go through the HLS transcode path when cast remotely.
const CAST_TRANSCODE_EXT = new Set([
  '.mkv', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.ts', '.m2ts', '.3gp',
  '.vob', '.rm', '.rmvb', '.divx', '.xvid', '.ogv',
]);
const CAST_DIRECT_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const CAST_DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const CAST_DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

/** Decide how a file reaches a remote receiver: original file or HLS. */
async function decideRemoteCast(sp) {
  const ext = path.extname(sp).toLowerCase();
  if (CAST_TRANSCODE_EXT.has(ext)) return 'hls';
  if (!CAST_DIRECT_EXT.has(ext) || !FFPROBE) return 'hls';
  try {
    const meta = await getVideoMetadata(sp);
    const okVideo = CAST_DIRECT_VIDEO.has(meta.codec)
      && (meta.codec !== 'h264' || !meta.pixFmt || /^yuvj?420p$/.test(meta.pixFmt));
    const okAudio = !meta.audioCodec || CAST_DIRECT_AUDIO.has(meta.audioCodec);
    if (okVideo && okAudio) return 'raw';
  } catch { /* fall through to transcode */ }
  return 'hls';
}

function castorHeaders(receiver) {
  const headers = { 'Content-Type': 'application/json' };
  if (receiver.pin) headers['X-Castor-Pin'] = receiver.pin;
  return headers;
}

app.get('/api/castor/receivers', async (_req, res) => {
  const discovered = await castorDiscovered();
  // Probe saved receivers in parallel so the UI can show online/state.
  const saved = await Promise.all(castorSaved.map(async (r) => {
    const info = await probeReceiver(r.url);
    return { ...r, pin: undefined, online: !!info, name: r.name || (info && info.name) || r.url, state: info ? info.state : null };
  }));
  const savedUrls = new Set(castorSaved.map(r => r.url));
  res.json({
    discovered: discovered.map(d => ({ ...d, saved: savedUrls.has(d.url) })),
    saved,
  });
});

app.post('/api/castor/receivers', async (req, res) => {
  const body = req.body || {};
  const url = normalizeReceiverUrl(body.url);
  if (!url) return res.status(400).json({ error: 'A http(s):// receiver URL is required' });
  const mode = body.mode === 'local' ? 'local' : 'remote';
  const info = await probeReceiver(url);
  if (!info) return res.status(502).json({ error: 'No Castor receiver answered at ' + url + ' (is it running?)' });
  const entry = {
    id: crypto.randomUUID(),
    url,
    name: String(body.name || info.name || url),
    mode,
    pin: String(body.pin || ''),
  };
  const existing = castorSaved.find(r => r.url === url);
  if (existing) Object.assign(existing, entry, { id: existing.id });
  else castorSaved.push(entry);
  saveCastorReceivers();
  const savedEntry = { ...entry, pin: undefined, online: true, state: info.state };
  res.json(existing ? { ok: true, updated: true, receiver: savedEntry } : { ok: true, receiver: savedEntry });
});

app.delete('/api/castor/receivers', (req, res) => {
  const before = castorSaved.length;
  castorSaved = castorSaved.filter(r => String(r.id) !== String(req.query.id));
  if (castorSaved.length === before) return res.status(404).json({ error: 'Receiver not found' });
  saveCastorReceivers();
  res.json({ ok: true });
});

app.post('/api/castor/cast', async (req, res) => {
  const body = req.body || {};
  const receiver = resolveReceiver(body);
  if (!receiver) return res.status(400).json({ error: 'Unknown receiver (receiverId or receiverUrl required)' });
  const sp = safePath(body.path);
  if (!sp) return res.status(400).json({ error: 'Invalid path' });
  const mode = body.mode === 'local' ? 'local' : 'remote';
  const title = path.basename(sp);
  let backend;

  let castBody;
  let createdStreamId = null;
  if (mode === 'local') {
    // Same-host receiver: hand it the file path as it exists on the host.
    castBody = { module: 'local', target: path.resolve('/' + body.path).replace(/^([a-zA-Z]:)/, '$1'), autoplay: true, title };
    backend = 'local-file';
  } else {
    const wantsTranscode = Boolean(body.res && body.res !== 'orig');
    const decision = wantsTranscode ? 'hls' : await decideRemoteCast(sp);
    backend = decision === 'hls' ? 'hls-transcode' : 'direct-file';
    const base = req.protocol + '://' + (req.get('host') || 'localhost');
    const namePart = encodeURIComponent(title);
    if (decision === 'raw') {
      castBody = {
        module: 'direct',
        target: base + '/api/video/cast/' + namePart + '?path=' + encodeURIComponent(body.path),
        autoplay: true,
        title,
      };
    } else {
      if (!FFMPEG || !FFPROBE) return res.status(500).json({ error: 'ffmpeg/ffprobe not found — remote transcoding unavailable' });
      let stream;
      try {
        stream = await startStreamSession(sp, {
          res: body.res,
          cq: body.cq,
          speed: body.speed,
          codec: body.codec,
          start: body.start,
        });
        createdStreamId = stream.id;
      } catch (err) {
        return res.status(500).json({ error: 'Transcode failed to start: ' + err.message });
      }
      castBody = {
        module: 'direct',
        target: base + '/api/video/cast/' + namePart + '.m3u8?session=' + stream.id,
        autoplay: true,
        title,
      };
    }
  }

  let rr;
  try {
    rr = await fetch(receiver.url + '/api/cast', {
      method: 'POST',
      headers: castorHeaders(receiver),
      body: JSON.stringify(castBody),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (createdStreamId) destroyStream(createdStreamId);
    return res.status(502).json({ error: 'Receiver unreachable: ' + err.message });
  }
  const data = await rr.json().catch(() => ({}));
  if (!rr.ok) {
    if (createdStreamId) destroyStream(createdStreamId);
    return res.status(502).json({ error: data.error || 'Receiver rejected the cast (HTTP ' + rr.status + ')', code: data.code });
  }
  // Clean up any previous HLS session that was feeding this receiver
  const prevCastStream = castStreams.get(receiver.url);
  if (prevCastStream && prevCastStream !== createdStreamId) destroyStream(prevCastStream);
  if (createdStreamId) castStreams.set(receiver.url, createdStreamId);
  else castStreams.delete(receiver.url);
  res.json({
    ok: true,
    mode,
    backend,
    target: castBody.target,
    receiver: { id: receiver.id, name: receiver.name, url: receiver.url },
    state: data.state || null,
  });
});

// Transport passthrough so the UI can show live state / stop playback.
const CASTOR_COMMANDS = new Set(['play', 'pause', 'stop', 'toggle', 'seek', 'seek-relative', 'volume', 'next', 'previous', 'fullscreen']);

app.post('/api/castor/command', async (req, res) => {
  const body = req.body || {};
  const receiver = resolveReceiver(body);
  if (!receiver) return res.status(400).json({ error: 'Unknown receiver' });
  const command = String(body.command || '');
  if (!CASTOR_COMMANDS.has(command)) return res.status(400).json({ error: 'Unsupported command' });
  try {
    const rr = await fetch(receiver.url + '/api/' + command, {
      method: 'POST',
      headers: castorHeaders(receiver),
      body: JSON.stringify(body.body || {}),
      signal: AbortSignal.timeout(8000),
    });
    const data = await rr.json().catch(() => ({}));
    return res.status(rr.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Receiver unreachable: ' + err.message });
  }
});

app.get('/api/castor/state', async (req, res) => {
  const receiver = resolveReceiver(req.query);
  if (!receiver) return res.status(400).json({ error: 'Unknown receiver' });
  try {
    const rr = await fetch(receiver.url + '/api/state', {
      headers: castorHeaders(receiver),
      signal: AbortSignal.timeout(8000),
    });
    const data = await rr.json().catch(() => ({}));
    return res.status(rr.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: 'Receiver unreachable: ' + err.message });
  }
});

function cleanupAllStreams() {
  for (const id of Array.from(streams.keys())) destroyStream(id);
}
process.once('SIGINT', () => { cleanupAllStreams(); process.exit(0); });
process.once('SIGTERM', () => { cleanupAllStreams(); process.exit(0); });

app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
  if (HOST_ROOT) console.log('Serving host filesystem from: ' + HOST_ROOT + ' (paths shown without the prefix)');
  if (!FFMPEG) console.log('WARNING: ffmpeg not found. Install ffmpeg for video transcoding.');
  if (!FFPROBE) console.log('WARNING: ffprobe not found. Install ffmpeg for video metadata.');
});
