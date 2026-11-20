/* ─── TV mode: spatial navigation for remotes, controllers and keyboards ─── */

/*
 * TV mode turns the UI into a focus-driven, pointer-free interface:
 *
 *   ← → ↑ ↓        move focus spatially
 *   Enter / Space  activate on release (hold ~600 ms for an item's menu)
 *   Backspace      back (disarm control → close layer → leave fullscreen →
 *                  folder up → history back → home)
 *
 * Bluetooth remotes and keyboards send those keys directly (plus optional
 * DPadCenter / OK / Back / ContextMenu keys); game controllers are polled via
 * the Gamepad API (D-pad, dominant left-stick axis, A = select / hold = menu,
 * B = back).
 *
 * Architecture:
 *   - Spatial picker: horizontal moves stay strictly on the same visual row
 *     inside the same region (so Left/Right never teleports to a toolbar or
 *     header). Vertical moves score edge-to-edge distance (`dy * 2.5 + dx`)
 *     within the current region first, crossing stacked regions (header ↔
 *     player ↔ main) only at a region edge. No vertical wrap on scrollable
 *     pages (holding Down at the bottom never catapults you back to the top).
 *   - Deterministic scrolling: computes the exact scroll container (page or
 *     scrollable modal/sheet/menu) and sticky chrome inset (.app-header,
 *     .video-area) directly, overriding `scroll-behavior: smooth` for the call,
 *     and scrolls all the way to 0 / maxScroll at a region's first / last stop.
 *   - Arm-to-edit: both <select> dropdowns and text <input> fields pass arrows
 *     through when merely focused, so navigation never gets trapped in a search
 *     box or a settings dropdown. Enter / Space / click / typing arms them
 *     (`.tv-armed`); Escape / Back / leaving disarms them.
 *   - Layer lifecycle: dialogs, sheets and menus trap navigation and remember
 *     the opener element so closing returns the focus ring where you left off.
 */

/* global Vue, SettingsStore */

const TvMode = (function () {
  'use strict';

  const state = Vue.reactive({ enabled: !!SettingsStore.settings.tvMode });

  /** Arrow / D-pad keys → direction. */
  const DIRS = {
    ArrowLeft: 'left', Left: 'left',
    ArrowRight: 'right', Right: 'right',
    ArrowUp: 'up', Up: 'up',
    ArrowDown: 'down', Down: 'down',
  };

  /** Keys that activate the focused control (keyboard + Bluetooth remotes). */
  const ACTIVATE_KEYS = new Set([
    'Enter', ' ', 'Spacebar', 'Select', 'DPadCenter', 'Accept', 'OK',
  ]);

  /** Keys that go back (keyboard + Bluetooth / TV remotes). */
  const BACK_KEYS = new Set([
    'Backspace', 'Escape', 'Esc', 'BrowserBack', 'GoBack', 'Back', 'XF86Back', 'Exit',
  ]);

  /** Keys that directly open the focused item's context menu. */
  const MENU_KEYS = new Set(['ContextMenu', 'Menu']);

  const FOCUSABLE = 'a[href], button:not([disabled]), ' +
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Overlay layers — while one is open, navigation stays inside it. */
  const LAYERS = '.modal-root, .settings-root, .vc-quality, .row-menu, .tag-fs';

  /** Compact popup menus where wrapping top↔bottom is helpful. */
  const WRAP_LAYERS = '.row-menu, .vc-quality';

  /**
   * Focus preference when a view is (re)focused: content first, never the
   * header. `main .up-btn` precedes `main .drive-chip` so an empty folder
   * lands on “Up one level” instead of jumping to a drive shortcut.
   */
  const PREFER = [
    '.vc-center',
    '.remote-btn-main',
    'main .file-row',
    'main .gallery-card',
    'main .up-btn',
    'main .drive-chip',
    'main button',
    'button',
  ];

  // D-pad only. A (0) and B (1) are handled separately by padSelect / goBack.
  const GAMEPAD_DPAD = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const DIRECTIONS = ['up', 'down', 'left', 'right'];

  /** Hold an activate key/button this long to open the item's menu. */
  const LONG_PRESS_MS = 600;
  const SCROLL_PAD = 16;

  let focusEl = null;        // element currently wearing the TV ring
  let lastPageFocus = null;  // last focused element outside any overlay layer
  let navFocusing = false;   // true while applyFocus() is calling .focus()
  let padRaf = null;         // gamepad poll loop handle
  let hintTimer = null;
  let navTimer = null;       // pending refocus retry
  let synthetic = false;     // guards re-entrancy of our own dispatched events
  let armedSelect = null;    // <select> currently taking ↑/↓
  let armedInput = null;     // text <input>/<textarea> currently taking typing
  const padHeld = new Map();
  let pressTimer = null;     // pending activate-key press (long-press detection)
  let pressFired = false;    // that press already opened a context menu
  let padBackHeld = false;   // B is edge-triggered (no repeat)
  const padPress = { active: false, fired: false, timer: null };

  /* ═══ Visibility & layers ══════════════════════════════════════════════ */

  /** True while an element is animating out via Vue <transition>. */
  function isLeaving(el) {
    if (!el) return false;
    if (typeof el.className === 'string') return el.className.includes('-leave-active');
    if (el.classList && el.classList.length) {
      for (let i = 0; i < el.classList.length; i++) {
        if (el.classList[i].endsWith('-leave-active')) return true;
      }
    }
    return false;
  }

  /**
   * True when an element can be reached with the TV focus.
   *
   * `pointer-events: none` is checked along the ancestor chain because the
   * player hides its bars on a container (`.vcontrols-hidden`, `.vc-ui-hidden`)
   * and `pointer-events` does not inherit to children.
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return hasPointerEvents(el);
  }

  function hasPointerEvents(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (isLeaving(node)) return false;
      if (getComputedStyle(node).pointerEvents === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }

  /** Topmost active overlay layer (scoped to fullscreen if active), or null. */
  function layer() {
    const fs = document.fullscreenElement || null;
    const root = fs || document;
    const list = root.querySelectorAll(LAYERS);
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (!el.isConnected || !el.getClientRects().length) continue;
      if (isLeaving(el)) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') continue;
      return el;
    }
    return null;
  }

  /** Active navigation root: topmost layer, else fullscreen element, else document. */
  function activeScope() {
    return layer() || document.fullscreenElement || document;
  }

  function focusablesIn(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(isVisible);
  }

  function candidates() {
    return focusablesIn(activeScope());
  }

  /* ═══ Scrolling (deterministic, container-aware) ═══════════════════════ */

  /**
   * Run a scroll operation with instant behaviour so CSS
   * `html { scroll-behavior: smooth }` never animates behind our back.
   */
  function instantScroll(container, fn) {
    const el = container || document.scrollingElement || document.documentElement;
    const style = el && el.style;
    const prev = style ? style.scrollBehavior : '';
    if (style) style.scrollBehavior = 'auto';
    try {
      fn(el);
    } finally {
      if (style) style.scrollBehavior = prev;
    }
  }

  /** Nearest vertically scrollable ancestor inside the current scope, or null (page). */
  function verticalScrollerOf(el) {
    const stop = layer() || document.body;
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const st = getComputedStyle(node);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll')
          && node.scrollHeight > node.clientHeight + 1) {
        return node;
      }
      if (node === stop) break;
      node = node.parentElement;
    }
    return null;
  }

  /** Scroll any horizontally overflowing ancestor (breadcrumbs, drive row) so `el` is visible. */
  function scrollHorizontalAncestors(el) {
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const st = getComputedStyle(node);
      if ((st.overflowX === 'auto' || st.overflowX === 'scroll')
          && node.scrollWidth > node.clientWidth + 1) {
        const cr = node.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        const pad = 12;
        if (er.left < cr.left + pad) {
          instantScroll(node, () => { node.scrollLeft += er.left - (cr.left + pad); });
        } else if (er.right > cr.right - pad) {
          instantScroll(node, () => { node.scrollLeft += er.right - (cr.right - pad); });
        }
      }
      node = node.parentElement;
    }
  }

  /**
   * Height from viewport top occupied by sticky chrome (.app-header, and
   * non-fullscreen .video-area) that floats over `main`.
   */
  function stickyTopInset(el) {
    if (document.fullscreenElement) return 0;
    if (!el.closest || !el.closest('main')) return 0;
    let bottom = 0;
    const header = document.querySelector('.app-header');
    if (header && header.getClientRects().length) {
      const hr = header.getBoundingClientRect();
      if (hr.bottom > bottom && hr.top < window.innerHeight) bottom = hr.bottom;
    }
    const videoArea = document.querySelector('.video-area');
    if (videoArea && videoArea.getClientRects().length) {
      const vr = videoArea.getBoundingClientRect();
      if (vr.bottom > bottom && vr.top < window.innerHeight && vr.bottom < window.innerHeight) {
        bottom = vr.bottom;
      }
    }
    return bottom;
  }

  function scrollPageTo(top) {
    const target = Math.max(0, top);
    instantScroll(null, () => {
      if (window.scrollTo) window.scrollTo(0, target);
      else if (window.scrollBy) window.scrollBy(0, target);
    });
  }

  function scrollPageBy(dy) {
    if (!dy) return;
    instantScroll(null, () => {
      if (window.scrollBy) window.scrollBy(0, dy);
    });
  }

  /**
   * Bring `el` cleanly into view inside its scroll container (or the page),
   * accounting for sticky header / sticky player chrome.
   */
  function scrollToFocus(el) {
    scrollHorizontalAncestors(el);

    // Elements inside sticky chrome (.app-header, .video-area) stay fixed in
    // the viewport — never scroll the page underneath them when focusing them.
    const inStickyChrome = !layer() && el.closest && !!el.closest('.app-header, .video-area');
    if (inStickyChrome) return;

    const scroller = verticalScrollerOf(el);
    const er = el.getBoundingClientRect();

    if (scroller) {
      const cr = scroller.getBoundingClientRect();
      const safeTop = cr.top + SCROLL_PAD;
      const safeBottom = cr.bottom - SCROLL_PAD;
      let dy = 0;
      if (er.top < safeTop) dy = er.top - safeTop;
      else if (er.bottom > safeBottom) dy = er.bottom - safeBottom;
      if (dy) instantScroll(scroller, () => { scroller.scrollTop += dy; });
      return;
    }

    const safeTop = stickyTopInset(el) + SCROLL_PAD;
    const safeBottom = (window.innerHeight || 900) - SCROLL_PAD;
    let dy = 0;
    if (er.top < safeTop) dy = er.top - safeTop;
    else if (er.bottom > safeBottom) dy = er.bottom - safeBottom;
    if (dy) scrollPageBy(dy);
  }

  /**
   * When focus arrives at the geometric top or bottom edge of its region (no
   * focusable element exists further in that direction within the region),
   * scroll the container all the way to 0 or its bottom so padding, titles,
   * info cards and footers are never left half-scrolled.
   */
  function scrollToRegionEdge(el, dir, scoped) {
    if (dir !== 'up' && dir !== 'down') return;
    const inStickyChrome = !layer() && el.closest && !!el.closest('.app-header, .video-area');
    if (inStickyChrome) return;

    const further = pick(scoped, el, dir, false);
    if (further) return;

    const scroller = verticalScrollerOf(el);
    if (scroller) {
      instantScroll(scroller, () => {
        scroller.scrollTop = dir === 'up' ? 0 : scroller.scrollHeight;
      });
      return;
    }
    if (dir === 'up') {
      scrollPageTo(0);
    } else {
      const root = document.scrollingElement || document.documentElement;
      scrollPageTo(root ? root.scrollHeight : 1e6);
    }
  }

  /* ═══ Focus ring ═══════════════════════════════════════════════════════ */

  function markFocus(el) {
    if (focusEl && focusEl !== el) focusEl.classList.remove('tv-focus');
    focusEl = el;
    if (el && el.classList) {
      el.classList.add('tv-focus');
      if (!el.closest || !el.closest(LAYERS)) lastPageFocus = el;
    }
  }

  function applyFocus(el, scroll) {
    if (!el) return null;
    clearRefocus();
    navFocusing = true;
    try {
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    } finally {
      navFocusing = false;
    }
    markFocus(el);
    if (scroll !== false) scrollToFocus(el);
    return el;
  }

  /** Focus whatever is best right now (used when nothing valid holds focus). */
  function focusFirst(scroll) {
    const scope = activeScope();
    const all = focusablesIn(scope);
    if (!all.length) return null;
    for (const sel of PREFER) {
      const el = scope.querySelector(sel);
      if (el && isVisible(el)) return applyFocus(el, scroll);
    }
    return applyFocus(all[0], scroll);
  }

  /** Return a valid focused element inside the active scope, repairing focus if needed. */
  function ensureFocus() {
    const scope = activeScope();
    const inScope = (el) => el && el !== document.body && isVisible(el)
      && (scope === document || scope.contains(el));
    const cur = document.activeElement;
    if (inScope(cur)) return cur;
    if (inScope(focusEl)) return applyFocus(focusEl, false);
    return focusFirst();
  }

  /* ═══ Spatial navigation ═══════════════════════════════════════════════ */

  /**
   * The page region an element belongs to.
   *
   * Horizontal navigation never leaves its region. Vertical navigation exhausts
   * the current region before stepping into a stacked region (.app-header ↔
   * .video-area ↔ main), so scrolled lists never alternate with sticky chrome.
   */
  function regionOf(el) {
    const scope = layer();
    if (scope) return scope;
    return (el.closest && el.closest('main, .app-header, .video-area')) || document.body;
  }

  function scoreHorizontal(a, acx, acy, b, dir, allowWrap) {
    const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (vOverlap <= 0) return null; // must vertically overlap (same visual row)
    const bcx = b.left + b.width / 2;
    const bcy = b.top + b.height / 2;
    const primary = (bcx - acx) * (dir === 'right' ? 1 : -1);
    if (primary > 1) {
      const dx = dir === 'right' ? Math.max(0, b.left - a.right) : Math.max(0, a.left - b.right);
      return { kind: 'best', score: dx + Math.abs(bcy - acy) * 2 + primary * 0.1 };
    }
    if (allowWrap) return { kind: 'wrap', score: -primary };
    return null;
  }

  function scoreVertical(a, acx, acy, b, dir, allowWrap) {
    const bcx = b.left + b.width / 2;
    const bcy = b.top + b.height / 2;
    const primary = (bcy - acy) * (dir === 'down' ? 1 : -1);
    // Skip siblings sitting on the exact same row (e.g. .row-menu-btn inside a row)
    const vEdgeSep = dir === 'down' ? (b.top - a.top) : (a.bottom - b.bottom);
    const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    if (primary > 1 && vEdgeSep > 2) {
      const dy = dir === 'down' ? Math.max(0, b.top - a.bottom) : Math.max(0, a.top - b.bottom);
      const dx = hOverlap > 0 ? 0 : Math.max(a.left - b.right, b.left - a.right);
      // Strongly favour candidates that share a column (hOverlap > 0) so an
      // adjacent tile with a slightly taller title never pulls Up/Down diagonally,
      // while ragged single-control rows (like Settings) still step row-by-row.
      const cxPenalty = hOverlap > 0 ? 0.05 : 0.35;
      return { kind: 'best', score: dy * 2.5 + dx * 2 + Math.abs(bcx - acx) * cxPenalty };
    }
    if (allowWrap && hOverlap > 0) return { kind: 'wrap', score: -primary };
    return null;
  }

  /**
   * Pick the best neighbour of `cur` in `dir` from `list`, or null.
   *
   * - Horizontal (`left`/`right`): strictly same visual row (`vOverlap > 0`)
   *   so pressing Left/Right never jumps to a nearby stacked row (like the seek
   *   bar 10 px above the transport buttons) or teleports to the toolbar/header.
   * - Vertical (`up`/`down`): edge-to-edge score `dy * 2.5 + dx + centerDiff * 0.05`.
   *   Prioritising `dy` walks cleanly row-by-row through both multi-column
   *   grids and ragged layouts (like Settings) without skipping nearby rows.
   * - `allowWrap`: only enabled inside compact menus (`.row-menu`, `.vc-quality`),
   *   never on scrollable pages where auto-repeat would catapult you top↔bottom.
   */
  function pick(list, cur, dir, allowWrap) {
    const a = cur.getBoundingClientRect();
    const acx = a.left + a.width / 2;
    const acy = a.top + a.height / 2;
    const scorer = (dir === 'left' || dir === 'right') ? scoreHorizontal : scoreVertical;

    let best = null;
    let bestScore = Infinity;
    let wrap = null;
    let wrapScore = -Infinity;

    for (const el of list) {
      const res = scorer(a, acx, acy, el.getBoundingClientRect(), dir, allowWrap);
      if (!res) continue;
      if (res.kind === 'best' && res.score < bestScore) { bestScore = res.score; best = el; }
      else if (res.kind === 'wrap' && res.score > wrapScore) { wrapScore = res.score; wrap = el; }
    }

    return best || wrap;
  }

  /** Vertical order of stacked page regions: header (0) → player (1) → main (2). */
  function regionRank(region) {
    if (!region || !region.classList) return 2;
    if (region.classList.contains('app-header')) return 0;
    if (region.classList.contains('video-area')) return 1;
    return 2;
  }

  /**
   * Pick a target in an adjacent stacked region when `cur` is at the edge of
   * its own region. Enforces header (0) → player (1) → main (2) so sticky
   * chrome can never be entered in the wrong vertical direction.
   */
  function pickCrossRegion(list, cur, dir, mine) {
    const myRank = regionRank(mine);
    const allowed = list.filter((el) => {
      const r = regionRank(regionOf(el));
      return dir === 'down' ? r > myRank : r < myRank;
    });
    return allowed.length ? pick(allowed, cur, dir, false) : null;
  }

  function moveFocus(dir) {
    if (!DIRECTIONS.includes(dir)) return;
    const cur = ensureFocus();
    if (!cur || cur === document.body) return;
    const list = candidates().filter(el => el !== cur);
    if (!list.length) return;

    const scope = layer();
    const canWrap = !!scope && !!scope.matches && scope.matches(WRAP_LAYERS);
    const mine = regionOf(cur);
    const scoped = list.filter(el => regionOf(el) === mine);
    const horizontal = dir === 'left' || dir === 'right';

    let next = pick(scoped, cur, dir, false);
    // Only vertical movement crosses stacked regions, and only in region order
    if (!next && !horizontal && !scope) next = pickCrossRegion(list, cur, dir, mine);
    if (!next && canWrap) next = pick(scoped, cur, dir, true);

    if (!next) {
      // Already at the edge of the region: make sure the edge is scrolled flush
      scrollToRegionEdge(cur, dir, scoped);
      return;
    }

    applyFocus(next);
    const nextRegion = regionOf(next);
    const nextScoped = nextRegion === mine
      ? list.filter(el => regionOf(el) === nextRegion && el !== next)
      : candidates().filter(el => regionOf(el) === nextRegion && el !== next);
    scrollToRegionEdge(next, dir, nextScoped);
  }

  /* ═══ Arm-to-edit: <select> and text <input> ═══════════════════════════ */

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type);
  }

  function armSelect(el) {
    disarmAll();
    armedSelect = el;
    el.classList.add('tv-armed');
  }

  function disarmSelect() {
    if (!armedSelect) return;
    armedSelect.classList.remove('tv-armed');
    armedSelect = null;
  }

  function armInput(el) {
    if (armedInput === el) return;
    disarmAll();
    armedInput = el;
    el.classList.add('tv-armed');
  }

  function disarmInput() {
    if (!armedInput) return;
    armedInput.classList.remove('tv-armed');
    armedInput = null;
  }

  function disarmAll() {
    disarmSelect();
    disarmInput();
  }

  /** Move the selection of an armed <select> and fire the same events a picker would. */
  function stepSelect(el, dir) {
    const count = el.options ? el.options.length : 0;
    if (!count) return;
    const next = Math.max(0, Math.min(count - 1, el.selectedIndex + (dir === 'down' ? 1 : -1)));
    if (next === el.selectedIndex) return;
    el.selectedIndex = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ═══ Activation & layer focus tracking ════════════════════════════════ */

  function activate() {
    const el = ensureFocus();
    if (!el || el === document.body) return;
    if (el.tagName === 'INPUT' && el.type === 'range') return;
    if (el.tagName === 'SELECT') {
      if (armedSelect === el) disarmSelect();
      else armSelect(el);
      return;
    }
    if (isTextField(el)) {
      if (armedInput === el) {
        if (el.form && el.form.requestSubmit) el.form.requestSubmit();
        else disarmInput();
      } else {
        armInput(el);
      }
      return;
    }
    el.click();
    afterActivate();
  }

  /**
   * After an activation (or closing a layer), reconcile focus with the topmost
   * layer: move into a newly opened overlay, or restore the last page focus
   * when an overlay just closed.
   */
  function afterActivate() {
    setTimeout(() => {
      if (!state.enabled) return;
      const scope = layer();
      const cur = document.activeElement;
      if (scope && (!cur || !scope.contains(cur))) {
        const first = focusablesIn(scope)[0];
        if (first) applyFocus(first);
        return;
      }
      if (!scope && (!cur || cur === document.body || !isVisible(cur))) {
        if (lastPageFocus && lastPageFocus.isConnected && isVisible(lastPageFocus)) {
          applyFocus(lastPageFocus, false);
        } else {
          ensureFocus();
        }
      }
    }, 60);
  }

  /* ═══ Range inputs (seek / volume sliders) ═════════════════════════════ */

  /**
   * A slider owns only the axis it is drawn along, leaving the other axis for
   * navigation so a remote is never trapped on it:
   *   data-tv-axis="x" (default) → ←/→ step value, ↑/↓ navigate (seek bar)
   *   data-tv-axis="y"           → ↑/↓ step value, ←/→ navigate (volume)
   */
  function rangeAxis(el) {
    return (el.getAttribute('data-tv-axis') || 'x').toLowerCase() === 'y' ? 'y' : 'x';
  }

  function rangeOwnsKey(el, dir) {
    const horizontal = dir === 'left' || dir === 'right';
    return rangeAxis(el) === 'y' ? !horizontal : horizontal;
  }

  function stepRange(el, dir) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return;
    const rawStep = parseFloat(el.getAttribute('data-tv-step'));
    const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : Math.max((max - min) / 50, 0.01);
    const plus = dir === 'right' || dir === 'up';
    let value = (parseFloat(el.value) || 0) + (plus ? step : -step);
    value = Math.min(max, Math.max(min, Math.round(value * 1000) / 1000));
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ═══ Back ═════════════════════════════════════════════════════════════ */

  function dispatchEscape() {
    if (synthetic) return;
    const target = document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : document.body;
    synthetic = true;
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
      }));
    } finally {
      synthetic = false;
    }
  }

  /**
   * Restore focus to the element that was active before an overlay opened.
   * Waits briefly for Vue's v-if / leave transition to settle.
   */
  function restoreAfterLayerClose() {
    setTimeout(() => {
      if (!state.enabled) return;
      if (layer()) return; // another layer is still open
      if (lastPageFocus && lastPageFocus.isConnected && isVisible(lastPageFocus)) {
        applyFocus(lastPageFocus, false);
      } else {
        ensureFocus();
      }
    }, 90);
  }

  /**
   * Back precedence:
   *   1. Disarm an armed <select> or text <input>
   *   2. Close the topmost overlay layer (and restore focus to its opener)
   *   3. Exit fullscreen
   *   4. View-level handler (`tv-back`, e.g. FileManager goes up one folder,
   *      VideoPlayer closes non-fullscreen tag panel)
   *   5. Browser history back, falling back to #/home
   */
  function goBack() {
    clearRefocus();
    clearPress();
    if (armedSelect) { disarmSelect(); return; }
    if (armedInput) { disarmInput(); return; }

    const scope = layer();
    if (scope) {
      dispatchEscape();
      setTimeout(() => {
        if (!scope.isConnected || isLeaving(scope) || !scope.getClientRects().length) {
          restoreAfterLayerClose();
          return;
        }
        const close = scope.querySelector(
          '.modal-header .icon-btn, .settings-header .icon-btn, [title="Close"]'
        );
        if (close) close.click();
        restoreAfterLayerClose();
      }, 60);
      return;
    }

    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      return;
    }

    const ev = new CustomEvent('tv-back', { cancelable: true, bubbles: true });
    document.dispatchEvent(ev);
    if (ev.defaultPrevented) {
      afterActivate();
      return;
    }

    const before = location.hash;
    window.history.back();
    setTimeout(() => {
      if (location.hash === before && before !== '#/home') location.hash = '#/home';
    }, 200);
  }

  /* ═══ Activation vs. long press ═══════════════════════════════════════ */

  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /**
   * Notify views of incoming remote/keyboard/gamepad activity before executing.
   * VideoPlayer uses this to reset its auto-hide timer and to wake a faded-out
   * overlay cleanly (cancelling the wake-up press so an invisible button isn't
   * triggered blindly).
   */
  function dispatchTvInput(kind, dir) {
    const ev = new CustomEvent('tv-input', {
      cancelable: true,
      bubbles: true,
      detail: { kind, dir: dir || null },
    });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  function startPress(e) {
    consume(e);
    clearRefocus();
    if (e.repeat) return;
    if (dispatchTvInput('activate')) return;
    clearPress();
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      pressFired = true;
      openContextMenu();
    }, LONG_PRESS_MS);
  }

  function endPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
      activate();
      return;
    }
    pressFired = false;
  }

  function clearPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressFired = false;
  }

  /**
   * Dispatch a synthetic `contextmenu` on the focused element. Components opt
   * in with `@contextmenu.prevent`; without one, fall back to normal activation.
   */
  function openContextMenu() {
    const el = ensureFocus();
    if (!el || el === document.body) return;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    if (ev.defaultPrevented) afterActivate();
    else activate();
  }

  /* ═══ Unified direction handling (keyboard + gamepad) ═════════════════ */

  function navigate(dir) {
    clearRefocus();
    clearPress();
    if (dispatchTvInput('dir', dir)) return;
    const active = document.activeElement;
    if (armedSelect && active === armedSelect) {
      if (dir === 'up' || dir === 'down') { stepSelect(armedSelect, dir); return; }
      disarmSelect();
    }
    if (armedInput && active === armedInput) {
      // Single-line inputs do not use ↑/↓, so leaving vertically is always safe
      if (dir === 'up' || dir === 'down') disarmInput();
      else return;
    }
    const isRange = !!active && active.tagName === 'INPUT' && active.type === 'range';
    if (isRange && rangeOwnsKey(active, dir)) { stepRange(active, dir); return; }
    moveFocus(dir);
  }

  /* ═══ Keyboard ═════════════════════════════════════════════════════════ */

  function handleArmedInputKey(e, active, key, dir) {
    if (!armedInput || active !== armedInput) return false;
    if (key === 'Escape') { consume(e); disarmInput(); return true; }
    // Up/Down leave a single-line <input> so a user is never trapped in search
    if (active.tagName === 'INPUT' && (dir === 'up' || dir === 'down')) {
      consume(e);
      disarmInput();
      moveFocus(dir);
      return true;
    }
    // Every other key (typing, ←/→ caret, Backspace, Enter to submit) belongs to the field
    return true;
  }

  function handleArmedSelectKey(e, active, key, dir) {
    if (!armedSelect || active !== armedSelect) return false;
    if (dir === 'up' || dir === 'down') { consume(e); stepSelect(armedSelect, dir); return true; }
    if (dir) { disarmSelect(); return false; }
    if (ACTIVATE_KEYS.has(key) || BACK_KEYS.has(key)) { consume(e); disarmSelect(); return true; }
    return false;
  }

  function onKeyDown(e) {
    if (!state.enabled || synthetic) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const active = document.activeElement;
    const key = e.key;
    const dir = DIRS[key];

    if (handleArmedInputKey(e, active, key, dir)) return;
    if (handleArmedSelectKey(e, active, key, dir)) return;

    // Typing a printable character directly on an unarmed text field arms it
    if (isTextField(active) && key.length === 1 && key !== ' ') {
      armInput(active);
      return;
    }

    if (dir) { consume(e); navigate(dir); return; }
    if (MENU_KEYS.has(key)) { consume(e); openContextMenu(); return; }
    if (ACTIVATE_KEYS.has(key)) { startPress(e); return; }
    if (BACK_KEYS.has(key)) { consume(e); goBack(); }
  }

  function onKeyUp(e) {
    if (!state.enabled) return;
    if (!ACTIVATE_KEYS.has(e.key)) return;
    if (!pressTimer && !pressFired) return;
    consume(e);
    endPress();
  }

  function onFocusIn(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    markFocus(el);
    // Programmatic or mouse focus into a text field (e.g. "Add folder",
    // "Edit path", clicking Search) arms it immediately for typing.
    if (!navFocusing && isTextField(el)) armInput(el);
  }

  function onFocusOut(e) {
    if (armedSelect && e.target === armedSelect) disarmSelect();
    if (armedInput && e.target === armedInput) disarmInput();
    if (!e.relatedTarget) markFocus(null);
  }

  function onWindowBlur() {
    clearPress();
  }

  /* ═══ Gamepad (D-pad + dominant left stick + A/B) ═════════════════════ */

  function padSelect(held) {
    if (held && !padPress.active) {
      padPress.active = true;
      clearTimeout(padPress.timer);
      padPress.timer = null;
      if (dispatchTvInput('activate')) {
        // Consumed to wake a hidden overlay — swallow release too
        padPress.fired = true;
        return;
      }
      padPress.timer = setTimeout(() => {
        padPress.timer = null;
        padPress.fired = true;
        openContextMenu();
      }, LONG_PRESS_MS);
      return;
    }
    if (!held && padPress.active) {
      padPress.active = false;
      if (padPress.timer) {
        clearTimeout(padPress.timer);
        padPress.timer = null;
        activate();
      }
      padPress.fired = false;
    }
  }

  /** Pick at most one direction from a gamepad (D-pad first, else dominant stick axis). */
  function readPadDirection(pad) {
    for (const index in GAMEPAD_DPAD) {
      const btn = pad.buttons[index];
      if (btn && btn.pressed) return GAMEPAD_DPAD[index];
    }
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    const magX = Math.abs(ax);
    const magY = Math.abs(ay);
    if (magX < 0.55 && magY < 0.55) return null;
    if (magX >= magY) return ax < 0 ? 'left' : 'right';
    return ay < 0 ? 'up' : 'down';
  }

  function hasConnectedGamepad() {
    if (!navigator.getGamepads) return false;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]) return true;
    }
    return false;
  }

  function pollGamepads() {
    if (!state.enabled) { padRaf = null; return; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const active = new Set();
    let selectHeld = false;
    let backHeld = false;

    for (const pad of pads) {
      if (!pad) continue;
      const d = readPadDirection(pad);
      if (d) active.add(d);
      if (pad.buttons[0] && pad.buttons[0].pressed) selectHeld = true;
      if (pad.buttons[1] && pad.buttons[1].pressed) backHeld = true;
    }

    const now = performance.now();
    for (const action of active) {
      const held = padHeld.get(action);
      if (!held) {
        padHeld.set(action, { since: now, last: now });
        navigate(action);
      } else if (now - held.since > 350 && now - held.last > 140) {
        held.last = now;
        navigate(action);
      }
    }
    for (const action of Array.from(padHeld.keys())) {
      if (!active.has(action)) padHeld.delete(action);
    }

    padSelect(selectHeld);
    if (backHeld && !padBackHeld) goBack();
    padBackHeld = backHeld;

    padRaf = requestAnimationFrame(pollGamepads);
  }

  function startGamepadLoop() {
    if (!state.enabled || padRaf || !navigator.getGamepads) return;
    padRaf = requestAnimationFrame(pollGamepads);
  }

  function onGamepadConnected() {
    if (state.enabled) startGamepadLoop();
  }

  function onGamepadDisconnected() {
    if (!hasConnectedGamepad()) stopGamepadLoop();
  }

  function stopGamepadLoop() {
    if (padRaf) cancelAnimationFrame(padRaf);
    padRaf = null;
    padHeld.clear();
    clearTimeout(padPress.timer);
    padPress.timer = null;
    padPress.active = false;
    padPress.fired = false;
    padBackHeld = false;
  }

  /* ═══ Hint toast ═══════════════════════════════════════════════════════ */

  function showHint(text) {
    const old = document.querySelector('.tv-hint');
    if (old) old.remove();
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }

    const el = document.createElement('div');
    el.className = 'tv-hint';
    el.textContent = text;
    document.body.append(el);
    hintTimer = setTimeout(() => { el.remove(); hintTimer = null; }, 3200);
  }

  /* ═══ Enable / disable ═════════════════════════════════════════════════ */

  function apply(on, isInit) {
    document.documentElement.classList.toggle('tv-mode', on);
    if (on) {
      // Only switch to the TV default layout when toggling on, not on reload
      if (!isInit) SettingsStore.settings.viewMode = 'gallery-tv';
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('focusout', onFocusOut, true);
      window.addEventListener('blur', onWindowBlur);
      window.addEventListener('gamepadconnected', onGamepadConnected);
      window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
      if (hasConnectedGamepad()) startGamepadLoop();
      if (!isInit) showHint('TV mode on — arrows to move, Enter to select, Backspace to go back');
      requestAnimationFrame(() => {
        if (!state.enabled) return;
        const main = document.querySelector('main');
        if (main && main.querySelector('.spinner')) refocus();
        else focusFirst();
      });
      return;
    }
    if (!isInit) SettingsStore.settings.viewMode = 'list';
    clearRefocus();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('gamepadconnected', onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
    clearPress();
    stopGamepadLoop();
    disarmAll();
    markFocus(null);
    const el = document.activeElement;
    if (el && el !== document.body && el.blur) el.blur();
    if (!isInit) showHint('TV mode off');
  }

  function clearRefocus() {
    if (navTimer) { clearTimeout(navTimer); navTimer = null; }
  }

  /**
   * Put the focus on the current view's content once it finishes loading
   * (waits while a `.spinner` is still visible in `main` so we don't prematurely
   * land on the toolbar or "Up one level" before the folder rows render).
   */
  function refocus() {
    if (!state.enabled) return;
    clearRefocus();
    let tries = 0;
    const tick = () => {
      navTimer = null;
      if (!state.enabled) return;
      const main = document.querySelector('main');
      const loading = main ? Boolean(main.querySelector('.spinner')) : false;
      const ready = !loading && (!main || focusablesIn(main).length > 0);
      if (ready || tries >= 25) { focusFirst(false); return; }
      tries++;
      navTimer = setTimeout(tick, 80);
    };
    navTimer = setTimeout(tick, 40);
  }

  function setEnabled(value) {
    const on = !!value;
    SettingsStore.settings.tvMode = on;
    if (state.enabled !== on) state.enabled = on;
  }

  function toggle() {
    setEnabled(!state.enabled);
  }

  /** Called once after the app is mounted (the DOM exists from here on). */
  function init() {
    if (state.enabled) apply(true, true);
  }

  Vue.watch(() => SettingsStore.settings.tvMode, (on) => {
    const enabled = Boolean(on);
    if (state.enabled !== enabled) state.enabled = enabled;
  });
  Vue.watch(() => state.enabled, (on) => apply(Boolean(on), false));
  window.addEventListener('hashchange', () => { if (state.enabled) refocus(); });

  /* ═══ Header toggle button ═════════════════════════════════════════════ */

  const TvToggle = {
    name: 'TvToggle',
    computed: {
      on() { return state.enabled; },
    },
    methods: {
      toggle,
    },
    template: `
  <button class="icon-btn tv-toggle" :class="{ on: on }" @click="toggle"
          role="switch" :aria-checked="on ? 'true' : 'false'"
          :title="on ? 'TV mode on (arrows + Enter)' : 'TV mode — navigate with a remote or the keyboard'"
          aria-label="TV mode">
    <ui-icon name="tv"></ui-icon>
  </button>
  `,
  };

  return {
    state,
    TvToggle,
    setEnabled,
    toggle,
    init,
    refocus,
    focusFirst,
    /** Put the TV focus on a specific element (keeps ring + scroll logic). */
    focusElement(el, scroll) { return applyFocus(el, scroll); },
  };
})();

window.TvMode = TvMode;
