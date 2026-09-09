/* ─── SettingsPanel: slide-up sheet (mobile) / right drawer (desktop) ────── */

/* global Vue, SettingsStore */

const SettingsPanel = {
  name: 'SettingsPanel',
  props: {
    open: { type: Boolean, default: false },
  },
  emits: ['close'],

  data() {
    return {
      confirmReset: false,
    };
  },

  computed: {
    s() { return SettingsStore.settings; },
    defaults() { return SettingsStore.defaults; },
  },

  watch: {
    open(isOpen) {
      if (isOpen) {
        this.confirmReset = false;
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
    },
  },

  methods: {
    resetAll() {
      if (!this.confirmReset) {
        this.confirmReset = true;
        return;
      }
      SettingsStore.reset();
      this.confirmReset = false;
    },
  },

  template: `
  <transition name="sheet">
    <div v-if="open" class="settings-root">

      <div class="settings-backdrop" @click="$emit('close')"></div>

      <div class="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">

        <header class="settings-header">
          <h2>Settings</h2>
          <button class="icon-btn" @click="$emit('close')" title="Close">
            <ui-icon name="close"></ui-icon>
          </button>
        </header>

        <div class="settings-body">

          <!-- ── Appearance ─────────────────────────────────────────── -->
          <section class="settings-group">
            <h3 class="group-title"><ui-icon name="light" :size="20"></ui-icon> Appearance</h3>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Theme</span>
                <span class="setting-desc">Dark or light interface</span>
              </div>
              <div class="segmented" role="radiogroup" aria-label="Theme">
                <button :class="{on: s.theme === 'dark'}" @click="s.theme = 'dark'">
                  <ui-icon name="dark" :size="18"></ui-icon> Dark
                </button>
                <button :class="{on: s.theme === 'light'}" @click="s.theme = 'light'">
                  <ui-icon name="light" :size="18"></ui-icon> Light
                </button>
              </div>
            </div>
          </section>

          <!-- ── Files & folders ─────────────────────────────────────── -->
          <section class="settings-group">
            <h3 class="group-title"><ui-icon name="folder" :size="20"></ui-icon> Files &amp; folders</h3>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Hide non-video files</span>
                <span class="setting-desc">Only show videos and folders while browsing</span>
              </div>
              <toggle-switch v-model="s.hideNonVideos"></toggle-switch>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Layout</span>
                <span class="setting-desc">How files are displayed</span>
              </div>
              <div class="segmented" role="radiogroup" aria-label="Layout">
                <button :class="{on: s.viewMode === 'list'}" @click="s.viewMode = 'list'">
                  <ui-icon name="list" :size="18"></ui-icon> List
                </button>
                <button :class="{on: s.viewMode === 'grid'}" @click="s.viewMode = 'grid'">
                  <ui-icon name="grid" :size="18"></ui-icon> Grid
                </button>
              </div>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Sort order</span>
                <span class="setting-desc">Default ordering (folders always first)</span>
              </div>
              <select v-model="s.sortOrder" class="setting-select" aria-label="Sort order">
                <option value="name-asc">Name A–Z</option>
                <option value="name-desc">Name Z–A</option>
                <option value="size-desc">Size (large first)</option>
                <option value="size-asc">Size (small first)</option>
                <option value="date-desc">Newest first</option>
                <option value="date-asc">Oldest first</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Remember last folder</span>
                <span class="setting-desc">Reopen the folder from your last visit</span>
              </div>
              <toggle-switch v-model="s.rememberPath"></toggle-switch>
            </div>
          </section>

          <!-- ── Video playback ───────────────────────────────────────── -->
          <section class="settings-group">
            <h3 class="group-title"><ui-icon name="videocam" :size="20"></ui-icon> Video playback</h3>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Resolution</span>
                <span class="setting-desc">Lower = much less data (never upscales)</span>
              </div>
              <select v-model="s.videoResolution" class="setting-select" aria-label="Streaming resolution">
                <option value="480">480p</option>
                <option value="720">720p</option>
                <option value="1080">1080p</option>
                <option value="orig">Original</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Quality</span>
                <span class="setting-desc">Lower quality = smaller files</span>
              </div>
              <select v-model="s.videoQuality" class="setting-select" aria-label="Encoder quality">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Encoding speed</span>
                <span class="setting-desc">Slower = smaller files at the same quality (more CPU/GPU)</span>
              </div>
              <select v-model="s.encodeSpeed" class="setting-select" aria-label="Encoding speed">
                <option value="fast">Fastest</option>
                <option value="balanced">Balanced</option>
                <option value="best">Best compression</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Autoplay</span>
                <span class="setting-desc">Start playing when a video is opened</span>
              </div>
              <toggle-switch v-model="s.autoplay"></toggle-switch>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Resume playback</span>
                <span class="setting-desc">Continue where you left off in each video</span>
              </div>
              <toggle-switch v-model="s.resumePlayback"></toggle-switch>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Autoplay next video</span>
                <span class="setting-desc">When a video ends, open the next one in the folder (unless loop is on)</span>
              </div>
              <toggle-switch v-model="s.autoNext"></toggle-switch>
            </div>

            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Transcode status</span>
                <span class="setting-desc">Show buffering progress while watching</span>
              </div>
              <toggle-switch v-model="s.showTranscodeInfo"></toggle-switch>
            </div>
          </section>

          <!-- ── Reset ────────────────────────────────────────────────── -->
          <section class="settings-group">
            <div class="setting-row">
              <div class="setting-text">
                <span class="setting-name">Reset settings</span>
                <span class="setting-desc">Restore all settings to their defaults</span>
              </div>
              <button class="btn danger" @click="resetAll">
                {{ confirmReset ? 'Tap again to confirm' : 'Reset' }}
              </button>
            </div>
          </section>

          <p class="settings-footer">SrvFiles · settings are saved in this browser</p>
        </div>
      </div>
    </div>
  </transition>
  `,
};

/** Simple accessible toggle switch */
const ToggleSwitch = {
  name: 'ToggleSwitch',
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  template: `
    <button class="toggle" :class="{on: modelValue}" role="switch"
            :aria-checked="modelValue ? 'true' : 'false'"
            @click="$emit('update:modelValue', !modelValue)">
      <span class="toggle-knob"></span>
    </button>
  `,
};
