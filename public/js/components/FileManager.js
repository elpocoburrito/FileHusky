/* ─── FileManager: browse view (drives, breadcrumbs, file list) ─────────── */

/* global Vue, Utils, SettingsStore */

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
      // scroll position memory, keyed by folder path (shared across instances)
      _scrollMem: FileManager._scrollMem || (FileManager._scrollMem = {}),
    };
  },

  computed: {
    s() { return SettingsStore.settings; },

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

      // "Videos only" mode: keep videos and folders
      if (this.s.hideNonVideos) {
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
  },

  unmounted() {
    document.removeEventListener('keydown', this.onMenuKey);
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
        const data = await Utils.api('/api/browse?path=' + encodeURIComponent(dirPath));
        this.data = data;
        document.title = (data.path === '/' || /\\$/.test(data.path) ? 'SrvFiles' : data.path.split(/[\\/]/).pop()) + ' — SrvFiles';
        await this.$nextTick();
        const savedScroll = this._scrollMem[data.path];
        if (savedScroll != null) window.scrollTo(0, savedScroll);
        else window.scrollTo(0, 0);
      } catch (e) {
        this.error = e.message;
        this.data = null;
      } finally {
        this.loading = false;
      }
      if (!this.drives.length) this.loadDrives();
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
      return 'file';
    },

    itemSub(item) {
      if (item.isDirectory) return 'Folder';
      return Utils.formatSize(item.size) + ' · ' + Utils.formatDate(item.mtime);
    },

    // ── Folder context menu (⋮): zip download + delete ─────────────────
    onMenuKey(e) {
      if (e.key === 'Escape' && this.menuFor) this.closeMenu();
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
      a.href = '/api/download/zip?path=' + encodeURIComponent(item.path);
      a.download = item.name + '.zip';
      document.body.append(a);
      a.click();
      a.remove();
    },

    async deleteFolder(item) {
      this.closeMenu();
      if (!confirm('Delete folder “' + item.name + '” and ALL of its contents?\n\nThis cannot be undone.')) return;
      try {
        await Utils.api('/api/folder?path=' + encodeURIComponent(item.path), { method: 'DELETE' });
        // If the deleted folder contains the folder we are browsing, go up
        const cur = this.data ? this.data.path : '';
        if (cur === item.path || cur.startsWith(item.path + '/') || cur.startsWith(item.path + '\\')) {
          const parent = item.path.replace(/[\\/][^\\/]*$/, '') || item.path;
          this.navigate(parent);
        } else {
          this.refresh();
        }
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    },
  },

  template: `
  <div class="page page-browse">

    <!-- ── Sticky header ─────────────────────────────────────────────── -->
    <header class="app-header">
      <div class="header-row">
        <button class="icon-btn header-home" @click="navigate('/')" title="Root">
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
          <button class="icon-btn" @click="$router.push({ name: 'tags' })" title="Manage tags">
            <ui-icon name="label"></ui-icon>
          </button>
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
          <button class="chip-toggle" :class="{on: s.hideNonVideos}"
                  @click="s.hideNonVideos = !s.hideNonVideos"
                  :title="s.hideNonVideos ? 'Showing videos & folders only' : 'Showing all files'">
            <ui-icon :name="s.hideNonVideos ? 'eye' : 'eyeOff'" :size="20"></ui-icon>
            <span>Videos</span>
          </button>

          <button class="icon-btn" @click="s.viewMode = s.viewMode === 'list' ? 'grid' : 'list'"
                  :title="s.viewMode === 'list' ? 'Grid view' : 'List view'">
            <ui-icon :name="s.viewMode === 'list' ? 'grid' : 'list'"></ui-icon>
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
        <p>{{ searchText ? 'Nothing matches “' + searchText + '”' : 'Empty folder' }}</p>
      </div>

      <!-- ── File list ───────────────────────────────────────────────── -->
      <ul v-else-if="s.viewMode === 'list'" class="file-list">
        <li v-for="item in visibleItems" :key="item.path" :class="{ 'has-menu': item.isDirectory }">
          <button class="file-row" @click="openItem(item)">
            <span class="file-icon" :class="item.isDirectory ? 'is-folder' : (item.isVideo ? 'is-video' : (item.isImage ? 'is-image' : 'is-file'))">
              <ui-icon :name="itemIcon(item)" :size="26"></ui-icon>
            </span>
            <span class="file-text">
              <span class="file-name">{{ item.name }}</span>
              <span class="file-sub">{{ itemSub(item) }}</span>
            </span>
            <ui-icon v-if="item.isVideo" name="play" :size="22" class="file-play"></ui-icon>
            <ui-icon v-else-if="item.isDirectory" name="chevronRight" :size="22" class="file-chevron"></ui-icon>
          </button>

          <!-- Folder context menu (⋮) -->
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

      <div v-else class="file-grid">
        <div v-for="item in visibleItems" :key="item.path" class="grid-cell">
          <button class="grid-card" @click="openItem(item)">
            <span class="grid-icon" :class="item.isDirectory ? 'is-folder' : (item.isVideo ? 'is-video' : (item.isImage ? 'is-image' : 'is-file'))">
              <ui-icon :name="itemIcon(item)" :size="44"></ui-icon>
            </span>
            <span class="grid-name">{{ item.name }}</span>
            <span class="grid-sub">{{ itemSub(item) }}</span>
            <span v-if="item.isVideo" class="grid-play"><ui-icon name="play" :size="18"></ui-icon></span>
          </button>

          <!-- Folder context menu (⋮) -->
          <template v-if="item.isDirectory">
            <button class="row-menu-btn grid" @click.stop="toggleMenu(item)"
                    title="Folder actions" aria-label="Folder actions">
              <ui-icon name="moreVert" :size="18"></ui-icon>
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
        </div>
      </div>
    </main>
  </div>
  `,
};
