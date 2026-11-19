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

  const GAMEPAD_ACTIONS = { 0: 'select', 1: 'back', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

  let focusEl = null;      // element currently wearing the TV ring
  let padRaf = null;       // gamepad poll loop handle
  let hintTimer = null;
  let navTimer = null;     // pending refocus retry
  let synthetic = false;   // guards re-entrancy of our own dispatched events
  let armedSelect = null;  // <select> that took the arrow keys (see armSelect)
  const padHeld = new Map();

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
    return hasPointerEvents(el) && !isCovered(el);
  }

  /**
   * True when another element is painted over the middle of `el`.
   *
   * The player page keeps its video area sticky, so the queue below scrolls
   * underneath it: without this test the focus ring could land on a row that
   * is hidden behind the player and never come back to the visible controls.
   * Targets outside the viewport are not tested — there is nothing to hit-test
   * against, and `scrollIntoView` brings them in once they take the focus.
   */
  function isCovered(el) {
    if (!document.elementFromPoint) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    return hit !== el && !el.contains(hit) && !hit.contains(el);
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

  function applyFocus(el, scroll) {
    if (!el) return null;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    markFocus(el);
    if (scroll !== false) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
   * Move the focus one step in `dir`.
   *
   * Candidates lined up on the perpendicular axis win on raw distance, so a
   * file list walks row by row instead of jumping to a closer button that
   * happens to sit beside the current row. When nothing is lined up the
   * off-axis penalty (`secondary * 2`) picks the most natural neighbour.
   * At the end of a list the direction wraps around, like a TV menu.
   */
  function moveFocus(dir) {
    const cur = ensureFocus();
    if (!cur || cur === document.body) return;
    const list = candidates().filter(el => el !== cur);
    if (!list.length) return;

    let aligned = null, alignedScore = Infinity;
    let loose = null, looseScore = Infinity;
    let wrap = null, wrapScore = -Infinity;

    for (const el of list) {
      const g = geometry(cur, el, dir);
      if (g.primary > 1) {
        if (g.cross > 0) {
          if (g.primary < alignedScore) { alignedScore = g.primary; aligned = el; }
        } else {
          const score = g.primary + g.secondary * 2;
          if (score < looseScore) { looseScore = score; loose = el; }
        }
      } else if (g.cross > 0) {
        const score = -g.primary;
        if (score > wrapScore) { wrapScore = score; wrap = el; }
      }
    }

    const next = aligned || loose || wrap;
    if (next) applyFocus(next);
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
   * A slider is the one control where ←/→ mean "adjust", not "move": the
   * horizontal axis is the value, while ↑/↓ leave the slider (otherwise focus
   * would be trapped on it — a remote has no Tab key). The step comes from
   * `data-tv-step` (seek = 10 s, volume = 5 %) so a press moves a useful
   * amount; `input` + `change` replay what a real drag does, keeping the
   * component's preview/commit handlers intact.
   */
  function stepRange(el, dir) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    if (!isFinite(min) || !isFinite(max)) return;
    const rawStep = parseFloat(el.getAttribute('data-tv-step'));
    const step = isFinite(rawStep) && rawStep > 0 ? rawStep : Math.max((max - min) / 50, 0.01);
    const plus = dir === 'right';
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

  /** An armed <select> owns ↑/↓ until it is closed again. */
  function handleArmedSelect(e, key, dir) {
    if (!armedSelect || document.activeElement !== armedSelect) return false;
    if (dir === 'up' || dir === 'down') { consume(e); stepSelect(armedSelect, dir); return true; }
    if (dir) { disarmSelect(); return false; }   // ←/→ leave the select, then navigate on
    if (isActivateKey(key) || key === 'Escape') { consume(e); disarmSelect(); return true; }
    return false;
  }

  /** ←/→ adjust a slider, ↑/↓ leave it; everything else moves the focus. */
  function handleDirection(e, active, dir) {
    const isRange = !!active && active.tagName === 'INPUT' && active.type === 'range';
    if (isRange && (dir === 'left' || dir === 'right')) {
      consume(e); stepRange(active, dir); return;
    }
    consume(e); moveFocus(dir);
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
    if (dir) { handleDirection(e, active, dir); return; }
    if (isActivateKey(key)) { consume(e); activate(); return; }
    if (BACK_KEYS.indexOf(key) !== -1) { consume(e); goBack(); }
  }

  function onFocusIn(e) {
    if (e.target && e.target.nodeType === 1) markFocus(e.target);
  }

  function onFocusOut(e) {
    if (armedSelect && e.target === armedSelect) disarmSelect();
    if (!e.relatedTarget) markFocus(null);
  }

  /* ═══ Gamepad (controllers; D-pad + left stick) ════════════════════════ */

  function padAction(action) {
    if (action === 'select') activate();
    else if (action === 'back') goBack();
    else moveFocus(action);
  }

  function pollGamepads() {
    if (!state.enabled) { padRaf = null; return; }
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const active = new Set();

    for (const pad of pads) {
      if (!pad) continue;
      for (const index in GAMEPAD_ACTIONS) {
        const btn = pad.buttons[index];
        if (btn && btn.pressed) active.add(GAMEPAD_ACTIONS[index]);
      }
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      // 0.6 deadzone: sticks rest well below it, but a firm push registers fast
      if (ax < -0.6) active.add('left');
      else if (ax > 0.6) active.add('right');
      if (ay < -0.6) active.add('up');
      else if (ay > 0.6) active.add('down');
    }

    const now = performance.now();
    for (const action of active) {
      const held = padHeld.get(action);
      if (!held) {
        padHeld.set(action, { since: now, last: now });
        padAction(action);
      } else if (now - held.since > 350 && now - held.last > 140) {
        held.last = now;
        padAction(action);
      }
    }
    for (const action of Array.from(padHeld.keys())) {
      if (!active.has(action)) padHeld.delete(action);
    }

    padRaf = requestAnimationFrame(pollGamepads);
  }

  function startGamepadLoop() {
    if (!padRaf && navigator.getGamepads) padRaf = requestAnimationFrame(pollGamepads);
  }

  function stopGamepadLoop() {
    if (padRaf) cancelAnimationFrame(padRaf);
    padRaf = null;
    padHeld.clear();
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
    document.removeEventListener('focusin', onFocusIn, true);
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
  };
})();

// Exposed like the other stores (SettingsStore, CastStore) and used by the
// components' templates/handlers.
window.TvMode = TvMode;
