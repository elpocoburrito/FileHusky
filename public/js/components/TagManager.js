/* ─── TagManager: dedicated page for managing tags and tag groups ─────────── */
/* global Vue, Utils */

const TagManager = {
  name: 'TagManager',
  emits: ['open-settings'],

  data() {
    return {
      groups: [],          // [{id, name, tags:[{id,name,groupId}]}]
      ungrouped: [],       // [{id, name, groupId: null}]
      loading: true,
      error: null,
      saving: false,

      newGroupName: '',
      newTagFor: 'none',   // 'none' = ungrouped, otherwise group id as string
      newTagName: '',

      editingGroupId: null,
      editingGroupName: '',
      editingTagId: null,
      editingTagName: '',
      editingTagGroup: 'none',
    };
  },

  computed: {
    // Groups as <option> entries for the "new tag" and "edit tag" selectors
    groupOptions() {
      return this.groups.map(g => ({ value: String(g.id), label: g.name }));
    },
  },

  mounted() {
    document.title = 'Tags — SrvFiles';
    this.load();
  },

  methods: {
    async load() {
      this.loading = true;
      this.error = null;
      try {
        const data = await Utils.api('/api/tags');
        this.groups = data.groups;
        this.ungrouped = data.ungrouped;
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },

    async run(promise) {
      if (this.saving) return;
      this.saving = true;
      try { await promise(); } catch (e) { alert(e.message); }
      this.saving = false;
    },

    goBack() {
      if (window.history.length > 1) window.history.back();
      else this.$router.replace({ name: 'browse', path: Utils.defaultPath() });
    },

    // ── Groups ──────────────────────────────────────────────────────────────
    async createGroup() {
      const name = this.newGroupName.trim();
      if (!name) return;
      await this.run(async () => {
        const g = await Utils.api('/api/groups', { method: 'POST', body: { name } });
        this.groups.push({ id: g.id, name: g.name, tags: [] });
        this.newGroupName = '';
      });
    },

    startEditGroup(group) {
      this.editingGroupId = group.id;
      this.editingGroupName = group.name;
      this.editingTagId = null;
      this.$nextTick(() => {
        const el = document.querySelector('.group-name-input');
        if (el) el.focus();
      });
    },

    async submitGroupEdit(group) {
      if (this.editingGroupId !== group.id) return; // already committed (Enter + blur)
      const name = this.editingGroupName.trim();
      this.editingGroupId = null;
      if (!name || name === group.name) return;
      await this.run(async () => {
        await Utils.api('/api/groups/' + group.id, { method: 'PUT', body: { name } });
        group.name = name;
      });
    },

    async deleteGroup(group) {
      if (!confirm('Delete group “' + group.name + '”? Its tags stay, but become ungrouped.')) return;
      await this.run(async () => {
        await Utils.api('/api/groups/' + group.id, { method: 'DELETE' });
        // Tags in the group move to "ungrouped" (server: ON DELETE SET NULL)
        this.ungrouped.push(...group.tags.map(t => ({ id: t.id, name: t.name, groupId: null })));
        this.groups = this.groups.filter(g => g.id !== group.id);
      });
    },

    // ── Tags ────────────────────────────────────────────────────────────────
    async createTag() {
      const name = this.newTagName.trim();
      if (!name) return;
      await this.run(async () => {
        const groupId = this.newTagFor === 'none' ? null : Number(this.newTagFor);
        const t = await Utils.api('/api/tags', { method: 'POST', body: { name, groupId } });
        const tag = { id: t.id, name: t.name, groupId };
        if (groupId != null) {
          const g = this.groups.find(g => g.id === groupId);
          if (g) g.tags.push(tag); else this.ungrouped.push(tag);
        } else {
          this.ungrouped.push(tag);
        }
        this.newTagName = '';
      });
    },

    startEditTag(tag) {
      this.editingTagId = tag.id;
      this.editingTagName = tag.name;
      this.editingTagGroup = tag.groupId != null ? String(tag.groupId) : 'none';
      this.editingGroupId = null;
      this.$nextTick(() => {
        const el = document.querySelector('.tag-edit-input');
        if (el) el.focus();
      });
    },

    /** Commit on blur — but only when focus truly left this tag's editors
     *  (clicking the group select must not discard the edit) */
    delayedTagCommit(tag) {
      setTimeout(() => {
        if (this.editingTagId !== tag.id) return;
        const ae = document.activeElement;
        if (ae && ae.closest && ae.closest('.tm-tag')) return;
        this.submitTagEdit(tag);
      }, 150);
    },

    async submitTagEdit(tag) {
      if (this.editingTagId !== tag.id) return; // already committed (Enter + blur)
      const name = this.editingTagName.trim();
      const groupId = this.editingTagGroup === 'none' ? null : Number(this.editingTagGroup);
      this.editingTagId = null;
      if (!name && groupId === tag.groupId) return;
      await this.run(async () => {
        await Utils.api('/api/tags/' + tag.id, {
          method: 'PUT',
          body: { name: name || tag.name, groupId },
        });
        // Move the tag between lists if its group changed
        const oldGroup = tag.groupId != null ? this.groups.find(g => g.id === tag.groupId) : null;
        const newGroup = groupId != null ? this.groups.find(g => g.id === groupId) : null;
        if (name) tag.name = name;
        tag.groupId = groupId;
        if (oldGroup && oldGroup !== newGroup) {
          oldGroup.tags = oldGroup.tags.filter(t => t.id !== tag.id);
        }
        if (newGroup && !newGroup.tags.some(t => t.id === tag.id)) {
          newGroup.tags.push(tag);
          this.ungrouped = this.ungrouped.filter(t => t.id !== tag.id);
        } else if (!newGroup && !this.ungrouped.some(t => t.id === tag.id)) {
          this.ungrouped.push(tag);
        }
      });
    },

    async deleteTag(tag) {
      if (!confirm('Delete tag “' + tag.name + '” from all videos?')) return;
      await this.run(async () => {
        await Utils.api('/api/tags/' + tag.id, { method: 'DELETE' });
        const g = tag.groupId != null ? this.groups.find(g => g.id === tag.groupId) : null;
        if (g) g.tags = g.tags.filter(t => t.id !== tag.id);
        this.ungrouped = this.ungrouped.filter(t => t.id !== tag.id);
      });
    },
  },

  template: `
  <div class="page page-tags">

    <!-- ── Sticky header ─────────────────────────────────────────────── -->
    <header class="app-header">
      <div class="header-row">
        <button class="icon-btn" @click="goBack" title="Back">
          <ui-icon name="arrowBack"></ui-icon>
        </button>
        <h1 class="header-title">Tags</h1>
        <button class="icon-btn" @click="$emit('open-settings')" title="Settings">
          <ui-icon name="settings"></ui-icon>
        </button>
      </div>
    </header>

    <main class="page-body tag-mgr-body">

      <div v-if="loading" class="state-block">
        <div class="spinner"></div>
        <p>Loading…</p>
      </div>

      <div v-else-if="error" class="state-block error">
        <ui-icon name="warning" :size="48"></ui-icon>
        <p>{{ error }}</p>
        <button class="btn primary" @click="load">Try again</button>
      </div>

      <template v-else>
        <p class="tag-mgr-intro">
          Tags are shown on every video's tagging overlay. Videos can carry
          several tags; within a group they behave like radio buttons —
          at most one tag per group is selected.
        </p>

        <!-- ── Groups ───────────────────────────────────────────────── -->
        <section v-for="group in groups" :key="group.id" class="tag-mgr-card">
          <div class="tm-group-head">
            <template v-if="editingGroupId === group.id">
              <input class="group-name-input" v-model="editingGroupName" type="text"
                     spellcheck="false" @keydown.enter.prevent="submitGroupEdit(group)"
                     @keydown.esc="editingGroupId = null"
                     @blur="submitGroupEdit(group)">
            </template>
            <template v-else>
              <h2 class="tm-group-name" @click="startEditGroup(group)"
                  title="Click to rename">{{ group.name }}</h2>
              <span class="tm-hint">exclusive group</span>
            </template>
            <button class="icon-btn small" @click="deleteGroup(group)" title="Delete group">
              <ui-icon name="close" :size="18"></ui-icon>
            </button>
          </div>

          <div class="tm-chips">
            <span v-for="tag in group.tags" :key="tag.id" class="tm-tag">
              <template v-if="editingTagId === tag.id">
                <input class="tag-edit-name" v-model="editingTagName" type="text"
                       spellcheck="false" @keydown.enter.prevent="submitTagEdit(tag)"
                       @keydown.esc="editingTagId = null" @blur="delayedTagCommit(tag)">
                <select class="tag-edit-group" v-model="editingTagGroup" title="Move to group"
                        @blur="delayedTagCommit(tag)">
                  <option value="none">No group</option>
                  <option v-for="opt in groupOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <button class="tm-tag-x" @mousedown.prevent @click="editingTagId = null" title="Cancel">
                  <ui-icon name="close" :size="14"></ui-icon>
                </button>
              </template>
              <template v-else>
                <button class="tm-tag-name" @click="startEditTag(tag)" title="Click to rename / move">
                  {{ tag.name }}
                </button>
                <button class="tm-tag-x" @click="deleteTag(tag)" title="Delete tag">
                  <ui-icon name="close" :size="14"></ui-icon>
                </button>
              </template>
            </span>
            <button class="tm-add-inline" @click="newTagFor = String(group.id); $nextTick(() => $refs.newTagInput && $refs.newTagInput.focus())">
              <ui-icon name="add" :size="16"></ui-icon> tag
            </button>
          </div>
        </section>

        <!-- ── Ungrouped tags ───────────────────────────────────────── -->
        <section v-if="ungrouped.length" class="tag-mgr-card">
          <div class="tm-group-head">
            <h2 class="tm-group-name">Ungrouped</h2>
            <span class="tm-hint">free tags</span>
          </div>
          <div class="tm-chips">
            <span v-for="tag in ungrouped" :key="tag.id" class="tm-tag">
              <template v-if="editingTagId === tag.id">
                <input class="tag-edit-name" v-model="editingTagName" type="text"
                       spellcheck="false" @keydown.enter.prevent="submitTagEdit(tag)"
                       @keydown.esc="editingTagId = null" @blur="delayedTagCommit(tag)">
                <select class="tag-edit-group" v-model="editingTagGroup" title="Move to group"
                        @blur="delayedTagCommit(tag)">
                  <option value="none">No group</option>
                  <option v-for="opt in groupOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <button class="tm-tag-x" @mousedown.prevent @click="editingTagId = null" title="Cancel">
                  <ui-icon name="close" :size="14"></ui-icon>
                </button>
              </template>
              <template v-else>
                <button class="tm-tag-name" @click="startEditTag(tag)" title="Click to rename / move">
                  {{ tag.name }}
                </button>
                <button class="tm-tag-x" @click="deleteTag(tag)" title="Delete tag">
                  <ui-icon name="close" :size="14"></ui-icon>
                </button>
              </template>
            </span>
          </div>
        </section>

        <div v-if="!groups.length && !ungrouped.length" class="state-block">
          <ui-icon name="label" :size="48"></ui-icon>
          <p>No tags yet — create the first one below.</p>
        </div>

        <!-- ── Create new ───────────────────────────────────────────── -->
        <section class="tag-mgr-card tm-create">
          <h2 class="tm-group-name">Add</h2>

          <form class="tm-create-form" @submit.prevent="createTag">
            <input ref="newTagInput" v-model="newTagName" class="tm-input" type="text"
                   placeholder="New tag name…" spellcheck="false" aria-label="New tag name">
            <select v-model="newTagFor" class="tm-select" aria-label="Group">
              <option value="none">No group</option>
              <option v-for="opt in groupOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
            <button class="btn primary" type="submit" :disabled="!newTagName.trim() || saving">
              <ui-icon name="add" :size="18"></ui-icon> New tag
            </button>
          </form>

          <form class="tm-create-form" @submit.prevent="createGroup">
            <input v-model="newGroupName" class="tm-input" type="text"
                   placeholder="New group name…" spellcheck="false" aria-label="New group name">
            <button class="btn" type="submit" :disabled="!newGroupName.trim() || saving">
              <ui-icon name="add" :size="18"></ui-icon> New group
            </button>
          </form>

          <p class="tm-note">
            A group such as “sunny / cloudy / rainy” keeps its tags exclusive:
            a video can carry only one tag of the group at a time. Ungrouped
            tags can be freely combined.
          </p>
        </section>
      </template>
    </main>
  </div>
  `,
};
