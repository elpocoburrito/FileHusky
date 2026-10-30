/* ─── CastPanel: pick a Castor receiver and cast the video ────────────────── */

/* global Vue, Utils, CastStore */

const CastPanel = {
  name: 'CastPanel',
  props: {
    path: { type: String, required: true },
    fileName: { type: String, default: '' },
    folder: { type: String, default: '' },
  },
  emits: ['close'],

  data() {
    return {
      loading: true,
      error: null,
      result: null,
      castingUrl: null,       // receiver currently being cast to
      rows: [],               // merged receiver list (saved first)
      // add-receiver form
      addUrl: '',
      addName: '',
      addMode: 'remote',
      addBusy: false,
      addError: null,
    };
  },

  mounted() {
    this.refresh();
  },

  methods: {
    async refresh() {
      this.loading = true;
      this.error = null;
      try {
        const data = await Utils.api('/api/castor/receivers');
        const saved = (data.saved || []).map(r => ({
          id: r.id,
          url: r.url,
          name: r.name,
          mode: r.mode || 'remote',
          online: !!r.online,
          state: r.state || null,
        }));
        const savedUrls = new Set(saved.map(r => r.url));
        const discovered = (data.discovered || [])
          .filter(d => !savedUrls.has(d.url))
          .map(d => ({
            id: null,
            url: d.url,
            name: d.name,
            mode: 'remote',
            online: true,
            state: null,
            discovered: true,
          }));
        this.rows = [...saved, ...discovered];
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    },

    modeLabel(r) {
      if (r.mode === 'local') return 'Local file';
      return 'Transcode';
    },

    stateText(r) {
      const st = r.state;
      if (!st || st.status === 'idle' || st.status === 'stopped') return '';
      const what = st.title ? '“' + st.title + '”' : 'video';
      if (st.status === 'playing') return 'Playing ' + what;
      if (st.status === 'paused') return 'Paused ' + what;
      if (st.status === 'loading') return 'Loading ' + what;
      if (st.status === 'error') return 'Error: ' + (st.error || 'playback failed');
      return '';
    },

    async cast(r) {
      this.castingUrl = r.url;
      this.error = null;
      this.result = null;
      try {
        const res = await CastStore.cast({
          path: this.path,
          name: this.fileName,
          folder: this.folder,
          receiver: { id: r.id, url: r.url, name: r.name, mode: r.mode },
        });
        r.state = res.state || null;
        let how = '';
        if (res.backend === 'hls-transcode') how = ' (transcoding)';
        else if (res.backend === 'direct-file' || res.backend === 'local-file') how = ' (direct play)';
        this.result = 'Casting “' + (this.fileName || this.path) + '” to ' + r.name + how;
      } catch (e) {
        this.error = e.message;
      }
      this.castingUrl = null;
    },

    async stop(r) {
      try {
        const active = CastStore.state.active && CastStore.state.receiver &&
          CastStore.state.receiver.url === r.url;
        let st;
        if (active) {
          st = await CastStore.stop();
        } else {
          const target = r.id ? { receiverId: r.id } : { receiverUrl: r.url };
          st = await Utils.api('/api/castor/command', {
            method: 'POST',
            body: Object.assign({ command: 'stop' }, target),
          });
        }
        r.state = st && st.state ? st.state : null;
      } catch (e) {
        this.error = e.message;
      }
    },

    async saveDiscovered(r) {
      try {
        const res = await Utils.api('/api/castor/receivers', {
          method: 'POST',
          body: { url: r.url, name: r.name, mode: r.mode },
        });
        r.id = res.receiver.id;
        this.result = 'Saved ' + r.name;
      } catch (e) {
        this.error = e.message;
      }
    },

    async changeMode(r) {
      if (!r.id) return;
      try {
        await Utils.api('/api/castor/receivers', {
          method: 'POST',
          body: { url: r.url, name: r.name, mode: r.mode },
        });
      } catch (e) {
        this.error = e.message;
      }
    },

    async removeReceiver(r) {
      try {
        await Utils.api('/api/castor/receivers?id=' + encodeURIComponent(r.id), { method: 'DELETE' });
        this.rows = this.rows.filter(x => x.url !== r.url);
      } catch (e) {
        this.error = e.message;
      }
    },

    async addReceiver() {
      this.addBusy = true;
      this.addError = null;
      try {
        const res = await Utils.api('/api/castor/receivers', {
          method: 'POST',
          body: { url: this.addUrl, name: this.addName, mode: this.addMode },
        });
        const rc = res.receiver;
        const existing = this.rows.find(x => x.url === rc.url);
        if (existing) Object.assign(existing, { id: rc.id, name: rc.name, mode: rc.mode });
        else this.rows.unshift({ id: rc.id, url: rc.url, name: rc.name, mode: rc.mode, online: true, state: rc.state || null });
        this.addUrl = '';
        this.addName = '';
        this.result = 'Added ' + rc.name;
      } catch (e) {
        this.addError = e.message;
      }
      this.addBusy = false;
    },

    onKey(e) {
      if (e.key === 'Escape') this.$emit('close');
    },
  },

  template: `
  <div class="modal-root" @click.self="$emit('close')" @keydown.esc="onKey">
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="Cast to receiver">
      <header class="modal-header">
        <h2>Cast to receiver</h2>
        <button class="icon-btn" @click="$emit('close')" title="Close">
          <ui-icon name="close"></ui-icon>
        </button>
      </header>

      <p class="modal-note">Casting <b>{{ fileName || path }}</b><br>
        Playback moves to the receiver — this app becomes its remote control. Opening
        another video keeps casting to the same receiver until you disconnect.</p>

      <div v-if="error" class="cast-msg cast-error"><ui-icon name="warning" :size="16"></ui-icon> {{ error }}</div>
      <div v-if="result" class="cast-msg cast-ok"><ui-icon name="check" :size="16"></ui-icon> {{ result }}</div>

      <div class="cast-section">
        <div class="cast-section-head">
          <span>Receivers on your network</span>
          <button class="icon-btn small" @click="refresh" title="Search again" :disabled="loading">
            <ui-icon name="refresh" :size="18"></ui-icon>
          </button>
        </div>

        <div v-if="loading" class="cast-empty"><div class="spinner"></div><p>Searching…</p></div>
        <div v-else-if="rows.length === 0" class="cast-empty">
          <p>No Castor receivers found.<br>Make sure a receiver is running, or add one below.</p>
        </div>

        <div v-for="r in rows" :key="r.url" class="cast-row">
          <span class="cast-icon" :class="{ offline: !r.online }"><ui-icon name="cast" :size="20"></ui-icon></span>
          <span class="cast-info">
            <span class="cast-name">{{ r.name }}<span v-if="!r.online" class="cast-offline"> (offline)</span></span>
            <span class="cast-url">{{ r.url }}</span>
            <span v-if="stateText(r)" class="cast-state">{{ stateText(r) }}</span>
          </span>
          <select class="cast-mode" v-model="r.mode" @change="changeMode(r)" title="Cast mode"
                  :aria-label="'Cast mode for ' + r.name">
            <option value="local">Local file</option>
            <option value="remote">Transcode</option>
          </select>
          <button class="btn primary cast-btn" :disabled="castingUrl === r.url || !r.online" @click="cast(r)">
            {{ castingUrl === r.url ? 'Casting…' : 'Cast' }}
          </button>
          <button v-if="stateText(r) && r.state.status !== 'idle' && r.state.status !== 'stopped'"
                  class="icon-btn small" title="Stop playback on receiver" @click="stop(r)">
            <ui-icon name="close" :size="16"></ui-icon>
          </button>
          <button v-if="r.id" class="icon-btn small danger" title="Remove receiver" @click="removeReceiver(r)">
            <ui-icon name="delete" :size="16"></ui-icon>
          </button>
          <button v-else class="icon-btn small" title="Save this receiver" @click="saveDiscovered(r)">
            <ui-icon name="check" :size="16"></ui-icon>
          </button>
        </div>
      </div>

      <div class="cast-section">
        <div class="cast-section-head"><span>Add receiver manually</span></div>
        <form class="cast-add-form" @submit.prevent="addReceiver">
          <input v-model="addUrl" type="text" class="cast-input cast-input-url" required
                 placeholder="http://192.168.1.50:8642" spellcheck="false" autocomplete="off">
          <input v-model="addName" type="text" class="cast-input" placeholder="Name (optional)" spellcheck="false">
          <select v-model="addMode" class="cast-mode" aria-label="Cast mode">
            <option value="local">Local file</option>
            <option value="remote">Transcode</option>
          </select>
          <button class="btn primary" type="submit" :disabled="addBusy">Add</button>
        </form>
        <p v-if="addError" class="cast-msg cast-error">{{ addError }}</p>
        <p class="modal-note">
          <b>Local file</b> — the receiver runs on the same machine as this server and reads
          the file directly from disk.<br>
          <b>Transcode</b> — the video is streamed from this server over HTTP; formats the
          receiver can't play are transcoded automatically.
        </p>
      </div>
    </div>
  </div>
  `,
};