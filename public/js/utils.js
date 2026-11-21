/* ─── FileHusky utils ────────────────────────────────────────────────────── */

/* One-time migration: the app used to be called SrvFiles and stored its
   browser state under `srvfiles-*` keys. Copy anything found under the old
   prefix (settings, last path, per-video resume positions) to the new
   `filehusky-*` keys, then drop the old ones. Runs before SettingsStore reads
   its key, and is a no-op once the old keys are gone. */
(function migrateLegacyKeys() {
  try {
    const OLD = 'srvfiles-';
    const NEW = 'filehusky-';
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(OLD)) stale.push(key);
    }
    for (const key of stale) {
      const next = NEW + key.slice(OLD.length);
      const value = localStorage.getItem(key);
      if (value !== null && localStorage.getItem(next) === null) {
        localStorage.setItem(next, value);
      }
      localStorage.removeItem(key);
    }
  } catch { /* storage unavailable — nothing to migrate */ }
})();

const Utils = {
  /** Fetch JSON, throw readable errors. opts: { method, body } (body → JSON) */
  async api(url, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET' };
    if (opts.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).error; } catch (_) { msg = res.statusText; }
      throw new Error(msg || ('HTTP ' + res.status));
    }
    return res.json();
  },

  /** 1234567 -> "1.2 MB" */
  formatSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  },

  /** 3671 -> "1:01:11" */
  formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  },

  /** Short locale date, e.g. "Mar 5, 2025" */
  formatDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } catch (_) { return ''; }
  },

  /** Detect platform for default path + breadcrumb separator */
  isWindows() {
    const nav = navigator.userAgent || navigator.platform || '';
    return /win/i.test(nav);
  },

  defaultPath() {
    return Utils.isWindows() ? 'C:\\' : '/';
  },

  /** Split a server path into clickable crumbs [{name, path}] */
  makeCrumbs(fullPath) {
    const isWin = /:\\/.test(fullPath + '\\') || /^[a-zA-Z]:/.test(fullPath);
    const sep = isWin ? '\\' : '/';
    const normalized = isWin ? fullPath.replace(/\//g, '\\') : fullPath;
    const parts = normalized.split(sep).filter(Boolean);
    const crumbs = [];
    let acc = '';
    if (isWin) {
      const driveMatch = normalized.match(/^([a-zA-Z]:)/);
      acc = driveMatch ? driveMatch[1] + '\\' : '';
      crumbs.push({ name: acc, path: acc });
      parts.shift(); // remove drive segment (already added)
    } else {
      acc = '/';
      crumbs.push({ name: '/', path: '/' });
    }
    for (const part of parts) {
      acc = isWin
        ? (acc.endsWith('\\') ? acc + part : acc + '\\' + part)
        : (acc.endsWith('/') ? acc + part : acc + '/' + part);
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  },

  /** Escape for safe use in CSS url() etc — not needed with Vue, kept for utils completeness */
  clampText(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }
};
