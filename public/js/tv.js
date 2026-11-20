/* ─── TV mode: spatial navigation for remotes, controllers and keyboards ─── */

/*
 * TV mode turns the UI into a focus-driven, pointer-free interface:
 *
 *   ← → ↑ ↓        move the focus spatially (nearest neighbour in that direction)
 *   Enter / Space  activate the focused element
 *   Backspace      back (close a menu/dialog, go up a folder, browser back)
 *
 * Bluetooth remotes and TV keyboards already send exactly those keys, so no
 * special handling is needed for them; game controllers are polled through the
 * Gamepad API (D-pad, left stick, A = select, B = back).
 *
 * The engine keeps a `.tv-focus` ring on the focused element (programmatic
 * focus does not always match `:focus-visible`) and scopes navigation to the
 * topmost open layer (dialog, quality menu, row menu, fullscreen tag panel) so
 * arrow keys cannot wander off into the page behind a modal.
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

  /** "Go back" keys: Backspace, Escape and the browser-back keys some remotes send. */
  const BACK_KEYS = ['Backspace', 'Escape', 'Esc', 'BrowserBack', 'GoBack'];

  const FOCUSABLE = 'a[href], button:not([disabled]), ' +
    'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** Overlay layers — while one is open, navigation stays inside it. */
  const LAYERS = '.modal-root, .settings-root, .vc-quality, .row-menu, .tag-fs';

  /**
   * Focus preference when a view is (re)focused: the content first, never the
   * header. `main .up-btn` comes before the drive chips so an empty folder
   * starts on “Up one level” instead of jumping to a drive shortcut.
   */
  const PREFER = [
    '.vc-center',
    'main .file-row', 'main .gallery-card',
    'main .up-btn',
    'main .drive-chip',
    'main button', 'button',
  ];

  // D-pad only. A (0) and B (1) are handled separately by padSelect/goBack —
  // keeping them in this map made them flow through moveFocus(), where an
  // unknown direction was treated as "up" (pressing A moved the focus up
  // before activating).
  const GAMEPAD_ACTIONS = { 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const DIRECTIONS = ['up', 'down', 'left', 'right'];

  let focusEl = null;      // element currently wearing the TV ring
  let padRaf = null;       // gamepad poll loop handle
  let hintTimer = null;
  let navTimer = null;     // pending refocus retry
  let synthetic = false;   // guards re-entrancy of our own dispatched events
  let armedSelect = null;  // <select> that took the arrow keys (see armSelect)
  const padHeld = new Map();
  let pressTimer = null;   // pending activate-key press (long-press detection)
  let pressFired = false;  // that press already opened a context menu
  let padBackHeld = false; // B is edge-triggered (no repeat)
  const padPress = { active: false, fired: false, timer: null };

  /** Hold an activate key/button this long to open the item's menu. */
  const LONG_PRESS_MS = 600;

  /* ═══ Visibility ═══════════════════════════════════════════════════════ */

  /**
   * True when an element can be reached with the TV focus.
   *
   * `pointer-events: none` is checked along the ancestor chain because the
   * player hides its bars on a container (`.vcontrols-hidden`, `.vc-ui-hidden`)
   * and `pointer-events` does not inherit to the children — focusing an
   * invisible-but-laid-out button would strand the user with no visible ring.
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (Number(style.opacity) === 0) return false;
    // A zero-sized control (e.g. a slider that only expands on hover) would
    // be an invisible focus stop; TV mode gives those a size in CSS instead.
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    return hasPointerEvents(el);
  }

  /**
   * Scroll a focused element out from under a sticky/fixed overlay.
   *
   * The player page keeps its video area sticky, so the queue below slides
   * underneath it (the same goes for the sticky header). Such a row is still
   * a valid target — skipping it is what made Up jump straight to the player
   * from the top visible row — but the ring must not stay hidden, so after
   * focusing we nudge the page until the element clears the overlay. The
   * overlay is whatever element actually sits on top of the target's centre,
   * so no component-specific knowledge is needed here.
   */
  function revealFocus(el) {
    if (!document.elementFromPoint) return;
    for (let pass = 0; pass < 2; pass++) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      // Outside the viewport: scrollIntoView already took care of it
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return;
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return;
      const cover = hit.getBoundingClientRect();
      // Overlay hanging from the top (header, player) → push the element
      // below it; an overlay at the bottom (bars) → pull it above.
      const dy = cover.bottom < window.innerHeight
        ? r.top - cover.bottom - 8
        : r.top + r.height - cover.top + 8;
      if (!dy) return;
      window.scrollBy(0, dy);
    }
  }

  function hasPointerEvents(el) {
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (getComputedStyle(node).pointerEvents === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }

  /** Topmost open overlay, or null. */
  function layer() {
    const list = document.querySelectorAll(LAYERS);
    for (let i = list.length - 1; i >= 0; i--) {
      const el = list[i];
      if (el.getClientRects().length && getComputedStyle(el).display !== 'none') return el;
    }
    return null;
  }

  function focusablesIn(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(isVisible);
  }

  function candidates() {
    return focusablesIn(layer() || document);
  }

  /* ═══ Focus ring ═══════════════════════════════════════════════════════ */

  function markFocus(el) {
    if (focusEl && focusEl !== el) focusEl.classList.remove('tv-focus');
    focusEl = el;
    if (el && el.classList) el.classList.add('tv-focus');
  }

  /**
   * Run a scroll operation with instant behaviour.
   *
   * The app sets `html { scroll-behavior: smooth }`, which makes every
   * `scrollIntoView()` animate — and a measurement taken right after it would
   * still see the old position, so the reveal pass and the smooth animation
   * fought each other (jitter on the way down, a half-scrolled position on the
   * way up). Navigation scrolls must be immediate and measurable, so the
   * inline style overrides the CSS for the duration of the call.
   */
  function instantScroll(fn) {
    const root = document.scrollingElement || document.documentElement;
    const style = root && root.style;
    const prev = style ? style.scrollBehavior : '';
    if (style) style.scrollBehavior = 'auto';
    try {
      fn(root);
    } finally {
      if (style) style.scrollBehavior = prev;
    }
  }

  /** Scroll the page to a given offset, immediately. */
  function scrollPageTo(top) {
    instantScroll(() => {
      if (window.scrollTo) window.scrollTo(0, top);
      else window.scrollBy(0, top);
    });
  }

  function applyFocus(el, scroll) {
    if (!el) return null;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    markFocus(el);
    if (scroll !== false) {
      instantScroll(() => {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        revealFocus(el);
      });
    }
    return el;
  }

  /** Focus whatever is best right now (used when nothing valid holds focus). */
  function focusFirst(scroll) {
    const scope = layer();
    const all = scope ? focusablesIn(scope) : candidates();
    if (!all.length) return null;
    for (const sel of PREFER) {
      const el = (scope || document).querySelector(sel);
      if (el && isVisible(el)) return applyFocus(el, scroll);
    }
    return applyFocus(all[0], scroll);
  }

  /** Return a valid focused element, repairing focus after the DOM changed. */
  function ensureFocus() {
    const cur = document.activeElement;
    if (cur && cur !== document.body && isVisible(cur)) return cur;
    if (focusEl && focusEl.isConnected && isVisible(focusEl)) return applyFocus(focusEl, false);
    return focusFirst();
  }

  /* ═══ Spatial navigation ═══════════════════════════════════════════════ */

  function overlap(a1, a2, b1, b2) {
    return Math.min(a2, b2) - Math.max(a1, b1);
  }

  /**
   * Relative geometry between the current element and a candidate.
   * `primary` is the distance along the direction of travel, `secondary` the
   * off-axis offset and `cross` the size of the shared projection on the
   * perpendicular axis (> 0 means the two elements line up, e.g. two rows of
   * the same list or two buttons of the same bar).
   */
  function geometry(cur, el, dir) {
    const a = cur.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    const bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
    if (dir === 'left' || dir === 'right') {
      return {
        primary: (bcx - acx) * (dir === 'right' ? 1 : -1),
        secondary: Math.abs(bcy - acy),
        cross: overlap(a.top, a.bottom, b.top, b.bottom),
      };
    }
    return {
      primary: (bcy - acy) * (dir === 'down' ? 1 : -1),
      secondary: Math.abs(bcx - acx),
      cross: overlap(a.left, a.right, b.left, b.right),
    };
  }

  /**
   * The page region an element belongs to.
   *
   * Navigation prefers staying inside the region it is in (`main` content,
   * the page header, the player surface). Pure geometry is not enough: the
   * sticky player and the sticky header float over the content, so a queue row
   * and a player/header button can look equally "above" the current element —
   * which made the focus alternate between the list and the chrome instead of
   * walking the list.
   */
  function regionOf(el) {
    return (el.closest && el.closest('main, .app-header, .video-area')) || document.body;
  }

  /**
   * Best candidate in `dir` from `cur`, or null.
   *
   * Candidates lined up on the perpendicular axis win on raw distance, so a
   * file list walks row by row instead of jumping to a closer button that
   * happens to sit beside the current row; the tiny `secondary` term breaks
   * ties in favour of the better-aligned neighbour (a row above beats a
   * header button that is exactly as far away but off to the side). When
   * nothing is lined up the off-axis penalty (`secondary * 2`) picks the most
   * natural neighbour. `allowWrap` re-enters the far end of a list, like a TV
   * menu, but is only tried once no candidate exists in that direction.
   */
  function pick(list, cur, dir, allowWrap) {
    let aligned = null, alignedScore = Infinity;
    let loose = null, looseScore = Infinity;
    let wrap = null, wrapScore = -Infinity;

    for (const el of list) {
      const g = geometry(cur, el, dir);
      if (g.primary > 1) {
        if (g.cross > 0) {
          const score = g.primary + g.secondary * 0.05;
          if (score < alignedScore) { alignedScore = score; aligned = el; }
        } else {
          const score = g.primary + g.secondary * 2;
          if (score < looseScore) { looseScore = score; loose = el; }
        }
      } else if (allowWrap && g.cross > 0) {
        const score = -g.primary;
        if (score > wrapScore) { wrapScore = score; wrap = el; }
      }
    }

    return aligned || loose || wrap;
  }

  /**
   * Move the focus one step in `dir`.
   *
   * Four passes, most specific first: same region without wrapping, any region
   * without wrapping, then the same two with wrap-around. That keeps the focus
   * inside the list it is in — walking a long queue up to its first row, then
   * to the info card, then to the player — instead of hopping to fixed chrome
   * that happens to sit at the same distance.
   */
  function moveFocus(dir) {
    if (DIRECTIONS.indexOf(dir) === -1) return; // never guess a direction
    const cur = ensureFocus();
    if (!cur || cur === document.body) return;
    const list = candidates().filter(el => el !== cur);
    if (!list.length) return;

    const mine = regionOf(cur);
    const scoped = list.filter(el => regionOf(el) === mine);
    const next = pick(scoped, cur, dir, false)
      || pick(list, cur, dir, false)
      || pick(scoped, cur, dir, true)
      || pick(list, cur, dir, true);
    if (!next) return;
    applyFocus(next);
    scrollToRegionEdge(next, dir);
  }

  /**
   * Fully scroll a region into view when its first/last stop is reached.
   *
   * Revealing a row puts it just below the sticky overlay, which leaves the
   * top (or bottom) of the page partly scrolled: reaching the first row of a
   * list would still hide the toolbar above it. Once the focus arrives at the
   * first/last stop of its region the page goes all the way to that edge.
   */
  function scrollToRegionEdge(el, dir) {
    if (dir !== 'up' && dir !== 'down') return;
    const mine = regionOf(el);
    const list = candidates().filter(candidate => regionOf(candidate) === mine);
    if (!list.length) return;
    if (dir === 'up' && list[0] === el) {
      scrollPageTo(0);
    } else if (dir === 'down' && list[list.length - 1] === el) {
      const root = document.scrollingElement || document.documentElement;
      scrollPageTo(root ? root.scrollHeight : 1e6);
    }
  }

  /* ═══ Activation ═══════════════════════════════════════════════════════ */

  function activate() {
    const el = ensureFocus();
    if (!el || el === document.body) return;
    if (el.tagName === 'INPUT' && el.type === 'range') return; // nothing to activate
    if (el.tagName === 'SELECT') { armSelect(el); return; }    // see armSelect
    el.click();
    afterActivate();
  }

  /* ═══ Selects (arrow keys only after the select is opened) ════════════ */

  /**
   * A <select> must not swallow the navigation keys just because it happens
   * to have the focus: on a settings page that makes the highlight jump from
   * list to list instead of moving on. It only takes ↑/↓ after being opened
   * (Enter/Space or a click), shows that with a dashed ring, and gives the
   * keys back on Enter/Escape/←/→ or when the focus leaves.
   */
  function armSelect(el) {
    disarmSelect();
    armedSelect = el;
    el.classList.add('tv-armed');
  }

  function disarmSelect() {
    if (!armedSelect) return;
    armedSelect.classList.remove('tv-armed');
    armedSelect = null;
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

  /**
   * After a click the DOM may have opened a menu or a dialog. Anything that
   * appeared gets the focus, and focus that died with a closed popup is
   * repaired, so the next arrow press never starts from `document.body`.
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
      if (!cur || cur === document.body || !isVisible(cur)) ensureFocus();
    }, 60);
  }

  /* ═══ Range inputs (seek / volume sliders) ═════════════════════════════ */

  /**
   * A slider consumes the axis it is *drawn* along and leaves the other one
   * for navigation, so a remote is never trapped on it (there is no Tab key):
   *
   *   data-tv-axis="x" (default)  ←/→ change the value, ↑/↓ move on  (seek bar)
   *   data-tv-axis="y"            ↑/↓ change the value, ←/→ move on  (volume)
   *
   * The volume rocker sits *between* buttons in the control bar, so on the x
   * axis it used to swallow every ←/→ and the bar could not be crossed. The
   * step comes from `data-tv-step` (seek = 10 s, volume = 5 %); `input` +
   * `change` replay what a real drag does, keeping the component's
   * preview/commit handlers intact.
   */
  function rangeAxis(el) {
    return (el.getAttribute('data-tv-axis') || 'x').toLowerCase() === 'y' ? 'y' : 'x';
  }

  /** True when this arrow key belongs to the slider instead of the navigation. */
  function rangeOwnsKey(el, dir) {
    const horizontal = dir === 'left' || dir === 'right';
    return rangeAxis(el) === 'y' ? !horizontal : horizontal;
  }

  function stepRange(el, dir) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    if (!isFinite(min) || !isFinite(max)) return;
    const rawStep = parseFloat(el.getAttribute('data-tv-step'));
    const step = isFinite(rawStep) && rawStep > 0 ? rawStep : Math.max((max - min) / 50, 0.01);
    const plus = dir === 'right' || dir === 'up';
    let value = (parseFloat(el.value) || 0) + (plus ? step : -step);
    value = Math.min(max, Math.max(min, Math.round(value * 1000) / 1000));
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ═══ Back ═════════════════════════════════════════════════════════════ */

  /**
   * Re-dispatch Escape from the focused element so the app's own handlers run
   * (dialogs, quality menu, tag overlay, folder row menu all close on Escape).
   */
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
   * Backspace: close the open layer, then leave fullscreen, then let the view
   * handle it (`tv-back`, FileManager goes up a folder), else browser history,
   * else home. A remote has a single back key, so it walks that order.
   */
  function goBack() {
    const scope = layer();
    if (scope) {
      dispatchEscape();
      // Dialogs that ignore Escape still offer a close button — use it.
      setTimeout(() => {
        if (!scope.isConnected || !scope.getClientRects().length) return;
        const close = scope.querySelector('.modal-header .icon-btn, .settings-header .icon-btn, [title="Close"]');
        if (close) close.click();
      }, 80);
      return;
    }

    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      return;
    }

    const ev = new CustomEvent('tv-back', { cancelable: true, bubbles: true });
    document.dispatchEvent(ev);
    if (ev.defaultPrevented) return;

    const before = location.hash;
    window.history.back();
    setTimeout(() => {
      // Deep-linked into a view with no history to go back to: fall back home
      if (location.hash === before && before !== '#/home') location.hash = '#/home';
    }, 200);
  }

  /* ═══ Keyboard ═════════════════════════════════════════════════════════ */

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type);
  }

  /** Handle the key exclusively, so app hotkeys (player seek, etc.) stay out. */
  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function isActivateKey(key) {
    return key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'Select';
  }

  /* ═══ Activation vs. long press ═══════════════════════════════════════ */

  /**
   * A press activates on **release**, which frees the press itself for a long
   * press: holding select (or Space/Enter) opens the item's context menu —
   * that is how the gallery reaches “cast / download / delete” now that its
   * ⋮ button is gone. Elements without a `contextmenu` handler fall back to a
   * normal activation, so holding a player button still works.
   */
  function startPress(e) {
    consume(e);
    if (e.repeat) return;                 // auto-repeat is not a new press
    clearPress();
    pressFired = false;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      pressFired = true;
      openContextMenu();
    }, LONG_PRESS_MS);
  }

  function endPress() {
    if (pressTimer) {                     // short press: activate now
      clearTimeout(pressTimer);
      pressTimer = null;
      activate();
      return;
    }
    pressFired = false;                   // long press already did its thing
  }

  function clearPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }

  /**
   * Ask the focused element for its actions menu. Components opt in with
   * `@contextmenu.prevent`; a synthetic event never opens the browser menu.
   * Without a handler this is just an activation, so a held key on a plain
   * button behaves like a press.
   */
  function openContextMenu() {
    const el = ensureFocus();
    if (!el || el === document.body) return;
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    if (ev.defaultPrevented) afterActivate();
    else activate();
  }

  /** An armed <select> owns ↑/↓ until it is closed again. */
  function handleArmedSelect(e, key, dir) {
    if (!armedSelect || document.activeElement !== armedSelect) return false;
    if (dir === 'up' || dir === 'down') { consume(e); stepSelect(armedSelect, dir); return true; }
    if (dir) { disarmSelect(); return false; }   // ←/→ leave the select, then navigate on
    if (isActivateKey(key) || key === 'Escape') { consume(e); disarmSelect(); return true; }
    return false;
  }

  /**
   * One direction step, whatever the input device.
   *
   * An armed <select> and a slider each own one axis; everything else moves
   * the focus. The keyboard and the gamepad both come through here, so a
   * controller gets exactly the same behaviour as a remote (the gamepad used
   * to call moveFocus directly, which is why ↑/↓ could not touch the volume).
   */
  function navigate(dir) {
    const active = document.activeElement;
    if (armedSelect && active === armedSelect) {
      if (dir === 'up' || dir === 'down') { stepSelect(armedSelect, dir); return; }
      disarmSelect();
    }
    const isRange = !!active && active.tagName === 'INPUT' && active.type === 'range';
    if (isRange && rangeOwnsKey(active, dir)) { stepRange(active, dir); return; }
    moveFocus(dir);
  }

  /** A slider owns the axis it is drawn along; every other arrow moves focus. */
  function handleDirection(e, dir) {
    consume(e);
    navigate(dir);
  }

  function onKeyDown(e) {
    if (!state.enabled || synthetic) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave browser/app chords alone

    const active = document.activeElement;
    const key = e.key;

    // In a text field every key belongs to the field (a remote cannot type,
    // but a keyboard user must be able to). Escape leaves the field.
    if (isTextField(active)) {
      if (key === 'Escape') { e.preventDefault(); active.blur(); }
      return;
    }

    const dir = DIRS[key];
    if (handleArmedSelect(e, key, dir)) return;
    if (dir) { handleDirection(e, dir); return; }
    if (isActivateKey(key)) { startPress(e); return; }
    if (BACK_KEYS.indexOf(key) !== -1) { consume(e); goBack(); }
  }

  /** Release of an activate key: short press activates, long press opened a menu. */
  function onKeyUp(e) {
    if (!state.enabled) return;
    if (!isActivateKey(e.key)) return;
    if (!pressTimer && !pressFired) return;   // a keyup we never started
    endPress();
  }

  function onFocusIn(e) {
    if (e.target && e.target.nodeType === 1) markFocus(e.target);
  }

  function onFocusOut(e) {
    if (armedSelect && e.target === armedSelect) disarmSelect();
    if (!e.relatedTarget) markFocus(null);
  }

  /* ═══ Gamepad (controllers; D-pad + left stick) ════════════════════════ */

  /** A = select (press/hold on the same long-press rule), B = back. */
  function padSelect(held) {
    if (held && !padPress.active) {
      padPress.active = true;
      clearTimeout(padPress.timer);
      padPress.timer = setTimeout(() => {
        padPress.timer = null;
        padPress.fired = true;
        openContextMenu();
      }, LONG_PRESS_MS);
      return;
    }
    if (!held && padPress.active) {
      padPress.active = false;
      if (padPress.timer) {          // released early: a normal select
        clearTimeout(padPress.timer);
        padPress.timer = null;
        activate();
      }
      padPress.fired = false;
    }
  }

  function pollGamepads() {
    if (!state.enabled) { padRaf = null; return; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const active = new Set();
    let selectHeld = false;
    let backHeld = false;

    for (const pad of pads) {
      if (!pad) continue;
      for (const index in GAMEPAD_ACTIONS) {
        const btn = pad.buttons[index];
        if (btn && btn.pressed) active.add(GAMEPAD_ACTIONS[index]);
      }
      if (pad.buttons[0] && pad.buttons[0].pressed) selectHeld = true;
      if (pad.buttons[1] && pad.buttons[1].pressed) backHeld = true;
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      // 0.6 deadzone: sticks rest well below it, but a firm push registers fast
      if (ax < -0.6) active.add('left');
      else if (ax > 0.6) active.add('right');
      if (ay < -0.6) active.add('up');
      else if (ay > 0.6) active.add('down');
    }

    // Directions repeat while held; select/back are edge-triggered only, so a
    // held A cannot machine-gun activations (it becomes a long press instead).
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
    if (!padRaf && navigator.getGamepads) padRaf = requestAnimationFrame(pollGamepads);
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

  function apply(on) {
    document.documentElement.classList.toggle('tv-mode', on);
    if (on) {
      // TV mode is a 10-foot UI: start on the large gallery layout
      SettingsStore.settings.viewMode = 'gallery-lg';
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('focusin', onFocusIn, true);
      document.addEventListener('focusout', onFocusOut, true);
      startGamepadLoop();
      showHint('TV mode on — arrows to move, Enter to select, Backspace to go back');
      requestAnimationFrame(() => focusFirst());
      return;
    }
    // Back to the desktop default
    SettingsStore.settings.viewMode = 'list';
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    document.removeEventListener('focusin', onFocusIn, true);
    clearPress();
    document.removeEventListener('focusout', onFocusOut, true);
    stopGamepadLoop();
    disarmSelect();
    markFocus(null);
    const el = document.activeElement;
    if (el && el !== document.body && el.blur) el.blur();
    showHint('TV mode off');
  }

  /** New view rendered by the router: put the focus on its content. */
  function refocus() {
    if (!state.enabled) return;
    if (navTimer) { clearTimeout(navTimer); navTimer = null; }
    let tries = 0;
    const tick = () => {
      navTimer = null;
      if (!state.enabled) return;
      const main = document.querySelector('main');
      const ready = main ? focusablesIn(main).length > 0 : false;
      // No scroll: the router already moved the page to the top of the view.
      if (ready || tries >= 20) { focusFirst(false); return; }
      tries++;
      navTimer = setTimeout(tick, 80);
    };
    navTimer = setTimeout(tick, 80);
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
    if (state.enabled) apply(true);
  }

  // The store is the single source of truth: the settings sheet, a reset and
  // the header button all converge here.
  Vue.watch(() => SettingsStore.settings.tvMode, (on) => {
    if (state.enabled !== !!on) state.enabled = !!on;
  });
  Vue.watch(() => state.enabled, (on) => apply(!!on));
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
    /** Put the TV focus on a specific element (keeps ring + reveal logic). */
    focusElement(el, scroll) { return applyFocus(el, scroll); },
  };
})();

// Exposed like the other stores (SettingsStore, CastStore) and used by the
// components' templates/handlers.
window.TvMode = TvMode;
