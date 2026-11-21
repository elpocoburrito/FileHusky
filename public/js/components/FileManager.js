/* ─── FileManager: browse view (drives, breadcrumbs, file list) ─────────── */

/* global Vue, Utils, SettingsStore, TvMode */

// Shared scroll and focus memory, keyed by folder path and kept across
// instances (the browse view is re-created on every navigation).
const SCROLL_MEM = {};
const FOCUS_MEM = {};

const FileManager = {
  name: 'FileManager',
  props: {
    path: { type: String, default: null },
  },
  emits: ['open-settings'],

  data() {
    return {
      drives: [],
      data: null,          // { path, parent, contents }
      loading: false,
      error: null,
      searchText: '',
      editPathText: '',
      editingPath: false,
      menuFor: null,        // path of the folder whose context menu is open
      // Files whose thumbnail could not be generated (icon fallback)
      noThumb: {},
      // scroll position memory, keyed by folder path (shared across instances)
      _scrollMem: SCROLL_MEM,
    };
  },

  computed: {
    s() { return SettingsStore.settings; },

    /** TV mode browses media only, by remote. */
    tvMode() { return TvMode.state.enabled; },

    crumbs() {
      if (!this.data || !this.data.path) return [];
      return Utils.makeCrumbs(this.data.path);
    },

    parentPath() {
      return this.data ? this.data.parent : null;
    },

    canGoUp() {
      return this.data && this.data.parent && this.data.path !== this.data.parent;
    },

    visibleItems() {
      if (!this.data) return [];
      let items = this.data.contents;

      // TV mode only browses media (folders + videos, images, audio), so a
      // remote never lands on a README, an .nfo or a subtitle file.
      if (this.tvMode) {
        items = items.filter(i => i.isDirectory || i.isVideo || i.isImage || i.isAudio);
      } else if (this.s.hideNonVideos) {
        // "Videos only" mode: keep videos and folders
        items = items.filter(i => i.isDirectory || i.isVideo);
      }

      // Search filter
      const q = this.searchText.trim().toLowerCase();
      if (q) {
        items = items.filter(i => i.name.toLowerCase().includes(q));
      }

      // Sorting (folders always first)
      const [key, dir] = this.s.sortOrder.split('-');
      const mul = dir === 'desc' ? -1 : 1;
      return items.slice().sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        let r = 0;
        if (key === 'size') r = a.size - b.size;
        else if (key === 'date') r = new Date(a.mtime) - new Date(b.mtime);
        else r = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return r * mul;
      });
    },

    activeDrive() {
      if (!this.data) return null;
      return this.drives.find(d => this.data.path.startsWith(d.path)) || null;
    },

    emptyMessage() {
      if (this.searchText) return `Nothing matches “${this.searchText}”`;
      if (this.tvMode) return 'No videos, images or audio in this folder';
      return 'Empty folder';
    },

    /** Icon of the button that switches to the next display mode. */
    viewToggleIcon() {
      if (this.s.viewMode === 'list') return 'grid';
      if (this.s.viewMode === 'gallery') return 'gridLarge';
      if (this.s.viewMode === 'gallery-lg') return 'gridTv';
      return 'list';
    },

    viewToggleTitle() {
      if (this.s.viewMode === 'list') return 'Small gallery view';
      if (this.s.viewMode === 'gallery') return 'Large gallery view';
      if (this.s.viewMode === 'gallery-lg') return 'TV gallery view';
      return 'List view';
    },

    galleryIconSize() {
      if (this.s.viewMode === 'gallery-tv') return 76;
      if (this.s.viewMode === 'gallery-lg') return 54;
      return 44;
    },

    galleryPlaySize() {
      return this.s.viewMode === 'gallery-tv' ? 24 : 18;
    },
  },

  watch: {
    path: {
      immediate: true,
      handler(newPath) {
        const target = newPath || this.initialPath();
        if (!newPath) {
          // First load: normalize the URL to the resolved path
          this.$router.replace({ name: 'browse', path: target });
        }
        this.load(target);
      },
    },
  },

  mounted() {
    document.addEventListener('keydown', this.onMenuKey);
    document.addEventListener('tv-back', this.onTvBack);
  },

  unmounted() {
    document.removeEventListener('keydown', this.onMenuKey);
    document.removeEventListener('tv-back', this.onTvBack);
    if (this.data) {
      this._scrollMem[this.data.path] = window.scrollY;
    }
  },

  methods: {
    initialPath() {
      if (this.s.rememberPath) {
        const last = localStorage.getItem('srvfiles-lastpath');
        if (last) return last;
      }
      return Utils.defaultPath();
    },

    async load(dirPath, force) {
      // Skip if this path is already being displayed or loaded (e.g. router
      // echoing our own replace back through the watcher)
      if (!force && this._loadedPath === dirPath && (this.data || this.loading)) return;
      this._loadedPath = dirPath;
      this.loading = true;
      this.error = null;
      this.searchText = '';
      this.editingPath = false;
      try {
        if (this.s.rememberPath) {
          try { localStorage.setItem('srvfiles-lastpath', dirPath); } catch {}
        }
        const data = await Utils.api(`/api/browse?path=${encodeURIComponent(dirPath)}`);
        this.data = data;
        this.loading = false;
        document.title = (data.path === '/' || data.path.endsWith('\\') ? 'SrvFiles' : data.path.split(/[\\/]/).pop()) + ' — SrvFiles';
        await this.$nextTick();
        const savedScroll = this._scrollMem[data.path];
        if (savedScroll == null) window.scrollTo(0, 0);
        else window.scrollTo(0, savedScroll);
        this.restoreTvFocus(data.path);
      } catch (e) {
        this.error = e.message;
        this.data = null;
        this.loading = false;
      }
      if (!this.drives.length) this.loadDrives();
    },

    /** Put TV focus on the previously opened item in this folder, or the first item. */
    restoreTvFocus(dirPath) {
      if (!TvMode.state.enabled) return;
      const wanted = FOCUS_MEM[dirPath];
      if (wanted) {
        const items = document.querySelectorAll('[data-tv-path]');
        for (const el of items) {
          if (el.getAttribute('data-tv-path') === wanted) {
            TvMode.focusElement(el);
            return;
          }
        }
      }
      TvMode.focusFirst(false);
    },

    async loadDrives() {
      try { this.drives = await Utils.api('/api/drives'); } catch { /* header hides drives */ }
    },

    navigate(p) {
      if (this.data) this._scrollMem[this.data.path] = window.scrollY;
      this.$router.push({ name: 'browse', path: p });
    },

    refresh() {
      if (this.data) this.load(this.data.path, true);
    },

    openItem(item) {
      if (this.data) FOCUS_MEM[this.data.path] = item.path;
      if (item.isDirectory) this.navigate(item.path);
      else if (item.isVideo) {
        this.$router.push({
          name: 'video',
          path: item.path,
          fileName: item.name,
          folder: this.data ? this.data.path : '',
        });
      }
      // Non-video files: no viewer yet — do nothing
    },

    toggleEditingPath() {
      this.editingPath = !this.editingPath;
      if (this.editingPath) {
        this.editPathText = this.data ? this.data.path : '';
        this.$nextTick(() => this.$refs.pathInput && this.$refs.pathInput.focus());
      }
    },

    submitPath() {
      const p = this.editPathText.trim();
      if (p) this.navigate(p);
      this.editingPath = false;
    },

    goUp() {
      if (this.canGoUp) this.navigate(this.data.parent);
    },

    itemIcon(item) {
      if (item.isDirectory) return 'folder';
      if (item.isVideo) return 'movie';
      if (item.isImage) return 'image';
      if (item.isAudio) return 'musicNote';
      return 'file';
    },

    /** CSS modifier for the type colour (list rows and gallery tiles). */
    itemClass(item) {
      if (item.isDirectory) return 'is-folder';
      if (item.isVideo) return 'is-video';
      if (item.isImage) return 'is-image';
      if (item.isAudio) return 'is-audio';
      return 'is-file';
    },

    // ── Gallery thumbnails (rendered live by the server, memory only) ──
    hasThumb(item) {
      return (item.isVideo || item.isImage) && !this.noThumb[item.path];
    },

    thumbUrl(item) {
      return `/api/thumb?path=${encodeURIComponent(item.path)}`;
    },

    onThumbError(item) {
      this.noThumb[item.path] = true;
    },

    // ── Gallery item actions (no ⋮ button: long press / right click) ──
    /** Open the actions menu for a folder (idempotent: used by both paths). */
    openItemMenu(item) {
      if (!item.isDirectory) return;
      this.menuFor = item.path;
    },

    onCardContextMenu(item, e) {
      if (!item.isDirectory) return;
      e.preventDefault();
      this.openItemMenu(item);
    },

    /**
     * Touch has no right click: hold a folder card (or a remote's select key,
     * which dispatches `contextmenu` through tv.js) to open its actions.
     */
    onCardPointerDown(item, e) {
      if (!item.isDirectory || e.pointerType === 'mouse') return; // right click already does it
      clearTimeout(this._lpTimer);
      this._lpFired = false;
      this._lpTimer = setTimeout(() => {
        this._lpFired = true;
        this.openItemMenu(item);
      }, 550);
    },

    onCardPointerUp() {
      clearTimeout(this._lpTimer);
    },

    /** Swallow the click that follows a long press (it opened the menu). */
    onCardClick(item) {
      if (this._lpFired) { this._lpFired = false; return; }
      this.openItem(item);
    },

    /** list → small gallery → large gallery → TV gallery → list */
    cycleViewMode() {
      const order = ['list', 'gallery', 'gallery-lg', 'gallery-tv'];
      const i = order.indexOf(this.s.viewMode);
      this.s.viewMode = order[(i + 1) % order.length];
    },

    itemSub(item) {
      if (item.isDirectory) return 'Folder';
      return `${Utils.formatSize(item.size)} · ${Utils.formatDate(item.mtime)}`;
    },

    // ── Folder context menu (⋮): zip download + delete ─────────────────
    onMenuKey(e) {
      if (e.key === 'Escape' && this.menuFor) this.closeMenu();
    },

    /** TV mode Backspace: close path edit if open, else go up one level. */
    onTvBack(e) {
      if (this.editingPath) {
        e.preventDefault();
        this.editingPath = false;
        return;
      }
      if (!this.canGoUp) return;
      e.preventDefault();
      this.goUp();
    },

    toggleMenu(item) {
      this.menuFor = this.menuFor === item.path ? null : item.path;
    },

    closeMenu() {
      this.menuFor = null;
    },

    downloadZip(item) {
      this.closeMenu();
      const a = document.createElement('a');
      a.href = `/api/download/zip?path=${encodeURIComponent(item.path)}`;
      a.download = `${item.name}.zip`;
      document.body.append(a);
      a.click();
      a.remove();
    },

    async deleteFolder(item) {
      this.closeMenu();
      if (!confirm(`Delete folder “${item.name}” and ALL of its contents?\n\nThis cannot be undone.`)) return;
      try {
        await Utils.api(`/api/folder?path=${encodeURIComponent(item.path)}`, { method: 'DELETE' });
        // If the deleted folder contains the folder we are browsing, go up
        const cur = this.data ? this.data.path : '';
        if (cur === item.path || cur.startsWith(item.path + '/') || cur.startsWith(item.path + '\\')) {
          const parent = item.path.replace(/[\\/][^\\/]*$/, '') || item.path;
          this.navigate(parent);
        } else {
          this.refresh();
        }
      } catch (e) {
        alert(`Delete failed: ${e.message}`);
      }
    },
  },

  template: `
  <div class="page page-browse">

    <!-- ── Sticky header ─────────────────────────────────────────────── -->
    <header class="app-header">
      <div class="header-row">
        <button class="icon-btn header-home" @click="$router.push({ name: 'home' })" title="Home">
          <ui-icon name="home"></ui-icon>
        </button>

        <nav v-if="!editingPath" class="breadcrumbs" aria-label="Breadcrumb">
          <template v-for="(crumb, i) in crumbs" :key="crumb.path">
            <span v-if="i > 0" class="crumb-sep">›</span>
            <button class="crumb" :class="{current: i === crumbs.length - 1}"
                    @click="navigate(crumb.path)">{{ crumb.name }}</button>
          </template>
        </nav>

        <form v-else class="path-edit" @submit.prevent="submitPath">
          <input ref="pathInput" v-model="editPathText" type="text"
                 class="path-input" placeholder="Enter path…" spellcheck="false"
                 @keydown.esc.prevent="editingPath = false">
        </form>

        <div class="header-actions">
          <button class="icon-btn" @click="toggleEditingPath"
                  :title="editingPath ? 'Cancel' : 'Type a path'">
            <ui-icon :name="editingPath ? 'close' : 'edit'"></ui-icon>
          </button>
          <button class="icon-btn" @click="refresh" title="Refresh">
            <ui-icon name="refresh"></ui-icon>
          </button>
          <tv-toggle></tv-toggle>
          <button class="icon-btn" @click="$emit('open-settings')" title="Settings">
            <ui-icon name="settings"></ui-icon>
          </button>
        </div>
      </div>
    </header>

    <main class="page-body">
      <!-- ── Drive shortcuts ─────────────────────────────────────────── -->
      <div v-if="drives.length > 0" class="drive-row" role="navigation" aria-label="Drives">
        <button v-for="d in drives" :key="d.path" class="drive-chip"
                :class="{active: activeDrive && activeDrive.path === d.path}"
                @click="navigate(d.path)">
          <ui-icon name="drive" :size="18"></ui-icon>
          <span class="drive-name">{{ d.name }}</span>
        </button>
      </div>

      <!-- ── Toolbar: search + view controls ────────────────────────── -->
      <div class="toolbar">
        <div class="search-box">
          <ui-icon name="search" :size="20"></ui-icon>
          <input v-model="searchText" type="search" class="search-input"
                 placeholder="Search this folder…" spellcheck="false">
          <button v-if="searchText" class="icon-btn small" @click="searchText = ''" title="Clear">
            <ui-icon name="close" :size="18"></ui-icon>
          </button>
        </div>

        <div class="toolbar-buttons">
          <span v-if="tvMode" class="tv-only-badge" title="TV mode shows media files only">
            <ui-icon name="eye" :size="20"></ui-icon>
            <span>Media</span>
          </span>
          <button v-else class="chip-toggle" :class="{on: s.hideNonVideos}"
                  @click="s.hideNonVideos = !s.hideNonVideos"
                  :title="s.hideNonVideos ? 'Showing videos & folders only' : 'Showing all files'">
            <ui-icon :name="s.hideNonVideos ? 'eye' : 'eyeOff'" :size="20"></ui-icon>
            <span>Videos</span>
          </button>

          <button class="icon-btn" @click="cycleViewMode" :title="viewToggleTitle">
            <ui-icon :name="viewToggleIcon"></ui-icon>
          </button>

          <select v-model="s.sortOrder" class="sort-select" title="Sort order"
                  aria-label="Sort order">
            <option value="name-asc">Name A–Z</option>
            <option value="name-desc">Name Z–A</option>
            <option value="size-desc">Size (large first)</option>
            <option value="size-asc">Size (small first)</option>
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
          </select>
        </div>
      </div>

      <!-- ── Up button ───────────────────────────────────────────────── -->
      <button v-if="canGoUp" class="up-btn" @click="goUp">
        <ui-icon name="arrowUp" :size="20"></ui-icon>
        <span>Up one level</span>
      </button>

      <!-- ── States ──────────────────────────────────────────────────── -->
      <!-- Backdrop: click anywhere closes an open folder menu -->
      <div v-if="menuFor" class="row-menu-backdrop" @click="closeMenu"></div>

      <div v-if="loading" class="state-block">
        <div class="spinner"></div>
        <p>Loading…</p>
      </div>

      <div v-else-if="error" class="state-block error">
        <ui-icon name="warning" :size="48"></ui-icon>
        <p>{{ error }}</p>
        <button class="btn primary" @click="refresh">Try again</button>
      </div>

      <div v-else-if="visibleItems.length === 0" class="state-block">
        <ui-icon name="folder" :size="48"></ui-icon>
        <p>{{ emptyMessage }}</p>
      </div>

      <!-- ── File list ───────────────────────────────────────────────── -->
      <ul v-else-if="s.viewMode === 'list'" class="file-list">
        <li v-for="item in visibleItems" :key="item.path" :class="{ 'has-menu': item.isDirectory }">
          <button class="file-row" :data-tv-path="item.path" @click="openItem(item)">
            <span class="file-icon" :class="itemClass(item)">
              <ui-icon :name="itemIcon(item)" :size="26"></ui-icon>
            </span>
            <span class="file-text">
              <span class="file-name">{{ item.name }}</span>
              <span class="file-sub">{{ itemSub(item) }}</span>
            </span>
            <ui-icon v-if="item.isVideo" name="play" :size="22" class="file-play"></ui-icon>
            <ui-icon v-else-if="item.isDirectory" name="chevronRight" :size="22" class="file-chevron"></ui-icon>
          </button>

          <!-- Row context menu (⋮): folder actions -->
          <template v-if="item.isDirectory">
            <button class="row-menu-btn" @click.stop="toggleMenu(item)"
                    title="Folder actions" aria-label="Folder actions">
              <ui-icon name="moreVert" :size="20"></ui-icon>
            </button>
            <div v-if="menuFor === item.path" class="row-menu">
              <button class="row-menu-item" @click="downloadZip(item)">
                <ui-icon name="download" :size="18"></ui-icon>
                <span>Download as ZIP</span>
              </button>
              <button class="row-menu-item danger" @click="deleteFolder(item)">
                <ui-icon name="delete" :size="18"></ui-icon>
                <span>Delete folder…</span>
              </button>
            </div>
          </template>
        </li>
      </ul>

      <!-- ── Gallery: small (gallery), large (gallery-lg), or TV (gallery-tv) ── -->
      <div v-else class="gallery-grid" :class="{
        'gallery-lg': s.viewMode === 'gallery-lg',
        'gallery-tv': s.viewMode === 'gallery-tv',
      }">
        <div v-for="item in visibleItems" :key="item.path" class="gallery-cell">
          <!-- No ⋮ button here: it sat between the rows and caught the focus
               on every move. Actions open on long press or right click, and
               tv.js dispatches a contextmenu event for a held select key. -->
          <button class="gallery-card" :data-tv-path="item.path" @click="onCardClick(item)"
                  @contextmenu="onCardContextMenu(item, $event)"
                  @pointerdown="onCardPointerDown(item, $event)"
                  @pointerup="onCardPointerUp"
                  @pointercancel="onCardPointerUp">
            <span class="gallery-thumb" :class="itemClass(item)">
              <img v-if="hasThumb(item)" class="thumb-img" :src="thumbUrl(item)"
                   loading="lazy" decoding="async" alt="" @error="onThumbError(item)">
              <ui-icon v-else :name="itemIcon(item)" :size="galleryIconSize"></ui-icon>
              <span v-if="item.isVideo" class="gallery-play">
                <ui-icon name="play" :size="galleryPlaySize"></ui-icon>
              </span>
            </span>
            <span class="gallery-text">
              <span class="gallery-name">{{ item.name }}</span>
              <span class="gallery-sub">{{ itemSub(item) }}</span>
            </span>
          </button>

          <!-- Actions menu: opened by long press / right click on folders -->
          <template v-if="item.isDirectory">
            <div v-if="menuFor === item.path" class="row-menu">
              <button class="row-menu-item" @click="downloadZip(item)">
                <ui-icon name="download" :size="18"></ui-icon>
                <span>Download as ZIP</span>
              </button>
              <button class="row-menu-item danger" @click="deleteFolder(item)">
                <ui-icon name="delete" :size="18"></ui-icon>
                <span>Delete folder…</span>
              </button>
            </div>
          </template>
        </div>
      </div>
    </main>
  </div>
  `,
};

// Classic script: registered by app.js through the global scope.
window.FileManager = FileManager;
