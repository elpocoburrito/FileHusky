/* ─── TagPanel: tags + rating editor shown inside the video player ────────── */
/* global Vue */

const TagPanel = {
  name: 'TagPanel',
  props: {
    // { groups: [{id, name, tags:[{id,name,groupId}]}], ungrouped: [...] }
    allTags: { type: Object, required: true },
    // ids of the tags currently applied to this video
    selected: { type: Array, default: () => [] },
    // 1–5 or null
    rating: { type: Number, default: null },
    loading: { type: Boolean, default: false },
  },
  emits: ['toggle-tag', 'set-rating', 'create-tag', 'close'],

  data() {
    return {
      newTagName: '',
      newTagGroup: '',   // group id (as string for <option>) or '' = ungrouped
    };
  },

  methods: {
    isSelected(tag) {
      return this.selected.includes(tag.id);
    },

    submitNew() {
      const name = this.newTagName.trim();
      if (!name) return;
      this.$emit('create-tag', { name, groupId: this.newTagGroup === '' ? null : Number(this.newTagGroup) });
      this.newTagName = '';
      this.newTagGroup = '';
    },
  },

  template: `
  <div class="tag-panel">

    <div class="tp-header">
      <span class="tp-title"><ui-icon name="label" :size="18"></ui-icon> Tags &amp; rating</span>
      <button class="icon-btn small" @click="$emit('close')" title="Close">
        <ui-icon name="close" :size="18"></ui-icon>
      </button>
    </div>

    <div v-if="loading" class="tp-loading"><div class="spinner"></div></div>

    <template v-else>
      <div v-if="!allTags.groups.length && !allTags.ungrouped.length" class="tp-empty">
        No tags yet. Create your first one below.
      </div>

      <!-- Tag groups (exclusive within a group) -->
      <div v-for="group in allTags.groups" :key="group.id" class="tp-group">
        <div class="tp-group-name">{{ group.name }}</div>
        <div class="tp-chips">
          <button v-for="tag in group.tags" :key="tag.id"
                  class="tag-chip" :class="{ on: isSelected(tag) }"
                  @click="$emit('toggle-tag', tag)">{{ tag.name }}</button>
        </div>
      </div>

      <!-- Ungrouped tags -->
      <div v-if="allTags.ungrouped.length" class="tp-group">
        <div class="tp-group-name">Tags</div>
        <div class="tp-chips">
          <button v-for="tag in allTags.ungrouped" :key="tag.id"
                  class="tag-chip" :class="{ on: isSelected(tag) }"
                  @click="$emit('toggle-tag', tag)">{{ tag.name }}</button>
        </div>
      </div>

      <!-- Star rating (1–5, or none) -->
      <div class="tp-group">
        <div class="tp-group-name">Rating</div>
        <div class="tp-stars-row">
          <div class="tp-stars">
            <button v-for="n in 5" :key="n" class="star-btn"
                    :class="{ on: rating != null && rating >= n }"
                    :title="n + ' star' + (n > 1 ? 's' : '')"
                    @click="$emit('set-rating', n)">
              <ui-icon name="star" :size="26"></ui-icon>
            </button>
          </div>
          <button v-if="rating != null" class="tp-clear" @click="$emit('set-rating', null)">
            No rating
          </button>
          <span v-else class="tp-unrated">Not rated</span>
        </div>
      </div>

      <!-- New tag -->
      <form class="tp-new" @submit.prevent="submitNew">
        <input v-model="newTagName" class="tp-new-input" type="text"
               placeholder="New tag…" spellcheck="false" aria-label="New tag name">
        <select v-model="newTagGroup" class="tp-new-group" aria-label="Group for new tag"
                :disabled="!allTags.groups.length">
          <option value="">No group</option>
          <option v-for="g in allTags.groups" :key="g.id" :value="String(g.id)">{{ g.name }}</option>
        </select>
        <button class="btn primary tp-new-btn" type="submit" :disabled="!newTagName.trim()">
          <ui-icon name="add" :size="18"></ui-icon> Add
        </button>
      </form>
    </template>
  </div>
  `,
};
