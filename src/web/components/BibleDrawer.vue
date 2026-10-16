<script setup lang="ts">
import { NBadge, NButton, NDrawer, NDrawerContent, NEmpty, NInput, NSelect, NTabPane, NTabs, NTag, NText } from 'naive-ui';
import { computed, ref, watch } from 'vue';
import { ENTRY_KINDS } from '../../shared/constants';
import type { BibleEntry, EntryKind } from '../../shared/types';
import { nameKey, useBibleStore } from '../stores/bible';
import { ENTRY_KIND_LABELS } from '../utils/labels';
import BibleCandidates from './BibleCandidates.vue';
import BibleEntryEditor from './BibleEntryEditor.vue';

/** 设定库（F5、ADR-009）：条目与事实的增删改；待审核候选。 */
const props = defineProps<{ show: boolean; workId: string }>();
const emit = defineEmits<{ 'update:show': [boolean]; extract: [] }>();
const bible = useBibleStore();

const tab = ref<'entries' | 'candidates'>('entries');
const kind = ref<EntryKind | 'all'>('all');
const search = ref('');
/** 选中的条目 id；'new' 表示正在新建。 */
const selected = ref<string | 'new' | null>(null);

const kindOptions = [{ label: '全部类型', value: 'all' }, ...ENTRY_KINDS.map((k) => ({ label: ENTRY_KIND_LABELS[k], value: k }))];

const visible = computed(() => {
  const q = nameKey(search.value);
  return bible.entries.filter((e) => (kind.value === 'all' || e.kind === kind.value) && (q === '' || [e.name, ...e.aliases].some((n) => nameKey(n).includes(q))));
});
const current = computed<BibleEntry | null>(() => (selected.value === null || selected.value === 'new' ? null : (bible.entryById.get(selected.value) ?? null)));

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    void bible.refresh().catch(() => undefined);
    // 有待审核的候选、设定库还是空的时候，直接打开待审核
    if (bible.entries.length === 0 && bible.pendingCount > 0) tab.value = 'candidates';
  },
);
// 选中的条目被删除后清除选择
watch(
  () => bible.entries,
  () => {
    if (selected.value !== null && selected.value !== 'new' && !bible.entryById.has(selected.value)) selected.value = null;
  },
);

function onSaved(e: BibleEntry): void {
  selected.value = e.id;
}
</script>

<template>
  <NDrawer :show="show" :width="980" placement="right" @update:show="emit('update:show', $event)">
    <NDrawerContent title="设定库" closable :native-scrollbar="false" data-testid="bible-drawer" body-content-style="padding-top: 4px">
      <NTabs v-model:value="tab" type="line" animated>
        <NTabPane name="entries" :tab="`条目（${bible.entries.length}）`" display-directive="show">
          <div class="layout">
            <aside class="list">
              <div class="filters">
                <NSelect v-model:value="kind" :options="kindOptions" size="small" class="kind" data-testid="bible-kind" />
                <NInput v-model:value="search" size="small" placeholder="搜索名称或别名" clearable data-testid="bible-search" />
              </div>
              <NButton size="small" block dashed class="new" data-testid="bible-new" @click="selected = 'new'">＋ 新建条目</NButton>
              <NEmpty v-if="visible.length === 0" size="small" :description="bible.entries.length === 0 ? '设定库还是空的' : '没有符合条件的条目'" class="empty" />
              <div
                v-for="e in visible"
                :key="e.id"
                class="entry"
                :class="{ active: e.id === selected }"
                data-testid="bible-entry"
                :data-entry-name="e.name"
                @click="selected = e.id"
              >
                <div class="entry-head">
                  <span class="entry-name">{{ e.name }}</span>
                  <NTag size="tiny" :bordered="false">{{ ENTRY_KIND_LABELS[e.kind] }}</NTag>
                </div>
                <NText v-if="e.aliases.length > 0" depth="3" class="entry-aliases">{{ e.aliases.join('、') }}</NText>
              </div>
            </aside>
            <main class="detail">
              <BibleEntryEditor v-if="selected !== null" :key="selected" :work-id="workId" :entry="current" @saved="onSaved" @deleted="selected = null" />
              <NEmpty v-else description="选择左侧的条目查看与编辑，或新建一个条目" class="empty" />
            </main>
          </div>
        </NTabPane>
        <NTabPane name="candidates" display-directive="show">
          <template #tab>
            <NBadge :value="bible.pendingCount" :show="bible.pendingCount > 0" :max="999" :offset="[10, -2]">
              <span data-testid="bible-tab-candidates">待审核</span>
            </NBadge>
          </template>
          <BibleCandidates @extract="emit('extract')" />
        </NTabPane>
      </NTabs>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.layout {
  display: flex;
  gap: 16px;
  min-height: 60vh;
}
.list {
  width: 280px;
  flex: none;
  border-right: 1px solid rgba(127, 127, 127, 0.15);
  padding-right: 12px;
}
.filters {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.kind {
  width: 110px;
  flex: none;
}
.new {
  margin-bottom: 8px;
}
.empty {
  margin-top: 32px;
}
.entry {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.entry:hover {
  background: rgba(127, 127, 127, 0.08);
}
.entry.active {
  background: rgba(24, 160, 88, 0.12);
}
.entry-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.entry-name {
  font-weight: 600;
}
.entry-aliases {
  font-size: 12px;
}
.detail {
  flex: 1;
  min-width: 0;
}
</style>
