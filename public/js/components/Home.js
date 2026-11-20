/* ─── HomePage: home menu with favorite folders ───────────────────────────── */

/* global Vue, Utils, TvMode */

const HomePage = {
  name: 'HomePage',
  emits: ['open-settings'],

  data() {
    return {
      folders: [],       // favorite folder paths (server-persisted)
      loading: true,
      error: null,
      adding: false,     // inline "add folder" form open
      newPath: '',
      removing: null,    // path currently being removed (optimistic UI)
    };
  },

  mounted() {
    document.addEventListener('keydown', this.onKey);
    document.addEventListener('tv-back', this.onTvBack);
    this.load();
  },

  unmounted() {
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('tv-back', this.onTvBack);
  },

  methods: {
    onKey(e) {
      if (e.key === 'Escape' && this.adding) this.adding = false;
    },

    onTvBack(e) {
      if (!this.adding) return;
      e.preventDefault();
      this.adding = false;
    },

    async load() {
      this.loading = true;
      this.error = null;
      try {
        const data = await Utils.api('/api/home/folders');
        this.folders = data.folders || [];
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
      if (TvMode.state.enabled) {
        await this.$nextTick();
        TvMode.focusFirst(false);
      }
    },

    openFolder(p) {
      this.$router.push({ name: 'browse', path: p });
    },

    folderName(p) {
      if (p === '/' || p === '\\' || /^[a-zA-Z]:\\?$/.test(p)) return 'Root';
      const parts = p.split(/[\\/]/).filter(Boolean);
      return parts.at(-1) || p;
    },

    startAdd() {
      this.adding = true;
      this.$nextTick(() => this.$refs.addInput && this.$refs.addInput.focus());
    },

    async submitAdd() {
      const p = this.newPath.trim();
      if (!p) return;
      try {
        const data = await Utils.api('/api/home/folders', { method: 'POST', body: { path: p } });
        this.folders = data.folders || [];
        this.adding = false;
        this.newPath = '';
      } catch (e) {
        alert('Could not add folder: ' + e.message);
      }
    },

    async removeFolder(p) {
      try {
        const data = await Utils.api('/api/home/folders?path=' + encodeURIComponent(p),
          { method: 'DELETE' });
        this.folders = data.folders || [];
      } catch (e) {
        alert('Could not remove folder: ' + e.message);
      }
    },
  },

  template: `
  <div class="page page-home">

    <!-- ── Sticky header ─────────────────────────────────────────────── -->
    <header class="app-header">
      <div class="header-row">
        <button class="icon-btn header-home current" disabled title="You are home">
          <ui-icon name="home"></ui-icon>
        </button>
        <h1 class="header-title">Home</h1>
        <div class="header-actions">
          <button class="icon-btn" @click="$router.push({ name: 'tags' })" title="Manage tags">
            <ui-icon name="label"></ui-icon>
          </button>
          <tv-toggle></tv-toggle>
          <button class="icon-btn" @click="$emit('open-settings')" title="Settings">
            <ui-icon name="settings"></ui-icon>
          </button>
        </div>
      </div>
    </header>

    <main class="page-body">
      <!-- ── Section head: title + Add button ───────────────────────── -->
      <div class="home-head">
        <h3 class="section-title">Folders</h3>
        <button v-if="!adding" class="btn primary" @click="startAdd">
          <ui-icon name="add" :size="18"></ui-icon> Add
        </button>
      </div>

      <!-- ── Inline add form ────────────────────────────────────────── -->
      <form v-if="adding" class="home-add" @submit.prevent="submitAdd">
        <input ref="addInput" v-model="newPath" type="text" class="path-input home-add-input"
               placeholder="Folder path, e.g. /media/videos" spellcheck="false"
               @keydown.esc.prevent="adding = false">
        <button class="btn primary" type="submit" :disabled="!newPath.trim()">Add</button>
        <button class="btn" type="button" @click="adding = false">Cancel</button>
      </form>

      <!-- ── States ─────────────────────────────────────────────────── -->
      <div v-if="loading" class="state-block">
        <div class="spinner"></div>
        <p>Loading…</p>
      </div>

      <div v-else-if="error" class="state-block error">
        <ui-icon name="warning" :size="48"></ui-icon>
        <p>{{ error }}</p>
        <button class="btn primary" @click="load">Try again</button>
      </div>

      <ul v-else class="file-list home-list">
        <li v-for="f in folders" :key="f" class="has-menu">
          <button class="file-row" @click="openFolder(f)">
            <span class="file-icon is-folder">
              <ui-icon name="folder" :size="26"></ui-icon>
            </span>
            <span class="file-text">
              <span class="file-name">{{ folderName(f) }}</span>
              <span class="file-sub">{{ f }}</span>
            </span>
            <ui-icon name="chevronRight" :size="22" class="file-chevron"></ui-icon>
          </button>
          <button class="row-menu-btn" @click.stop="removeFolder(f)"
                  title="Remove from home" aria-label="Remove from home">
            <ui-icon name="delete" :size="20"></ui-icon>
          </button>
        </li>
      </ul>

      <div v-if="!loading && !error && folders.length === 0" class="state-block">
        <ui-icon name="folder" :size="48"></ui-icon>
        <p>No folders yet — add one with the button above.</p>
      </div>
    </main>
  </div>
  `,
};
