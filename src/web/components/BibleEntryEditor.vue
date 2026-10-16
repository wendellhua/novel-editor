<script setup lang="ts">
import { NButton, NDynamicTags, NEmpty, NForm, NFormItem, NInput, NPopconfirm, NSelect, NSpace, NSwitch, NTag, NText, useMessage } from 'naive-ui';
import { computed, ref, watch } from 'vue';
import { ENTRY_KINDS } from '../../shared/constants';
import type { BibleEntry, BibleFact, EntryKind } from '../../shared/types';
import { bibleApi } from '../api/bible';
import { ApiError } from '../api/client';
import { useBibleStore } from '../stores/bible';
import { useWorkspaceStore } from '../stores/workspace';
import { ENTRY_KIND_LABELS } from '../utils/labels';

/** 设定条目的编辑：名称、别名、类型、简介，以及事实的增删改。entry 为 null 时是新建。 */
const props = defineProps<{ workId: string; entry: BibleEntry | null }>();
const emit = defineEmits<{ saved: [entry: BibleEntry]; deleted: [] }>();
const bible = useBibleStore();
const ws = useWorkspaceStore();
const message = useMessage();

const kindOptions = ENTRY_KINDS.map((k) => ({ label: ENTRY_KIND_LABELS[k], value: k }));
const form = ref<{ kind: EntryKind; name: string; aliases: string[]; summary: string }>({ kind: 'character', name: '', aliases: [], summary: '' });
const saving = ref(false);
const facts = ref<BibleFact[]>([]);
const factsLoading = ref(false);
const draft = ref({ attribute: '', value: '', mutable: false });
const editing = ref<{ id: string; attribute: string; value: string; mutable: boolean } | null>(null);

const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError ? err.message : fallback);

async function loadFacts(): Promise<void> {
  const e = props.entry;
  facts.value = [];
  if (e === null) return;
  factsLoading.value = true;
  try {
    const list = await bibleApi.facts(props.workId, e.id);
    if (props.entry?.id === e.id) facts.value = list;
  } catch (err) {
    message.error(errorText(err, '读取事实失败'));
  } finally {
    factsLoading.value = false;
  }
}

watch(
  () => props.entry,
  (e) => {
    form.value = e === null ? { kind: 'character', name: '', aliases: [], summary: '' } : { kind: e.kind, name: e.name, aliases: [...e.aliases], summary: e.summary };
    editing.value = null;
    void loadFacts();
  },
  { immediate: true },
);

const dirty = computed(() => {
  const e = props.entry;
  if (e === null) return form.value.name.trim() !== '';
  return e.kind !== form.value.kind || e.name !== form.value.name || e.summary !== form.value.summary || JSON.stringify(e.aliases) !== JSON.stringify(form.value.aliases);
});

async function save(): Promise<void> {
  if (form.value.name.trim() === '') {
    message.warning('名称不能为空');
    return;
  }
  saving.value = true;
  try {
    const input = { kind: form.value.kind, name: form.value.name, aliases: form.value.aliases, summary: form.value.summary };
    const saved = props.entry === null ? await bible.createEntry(input) : await bible.updateEntry(props.entry.id, input);
    message.success(props.entry === null ? `已新建条目「${saved.name}」` : '已保存');
    emit('saved', saved);
  } catch (err) {
    message.error(errorText(err, '保存失败'));
  } finally {
    saving.value = false;
  }
}

async function remove(): Promise<void> {
  if (props.entry === null) return;
  try {
    await bible.deleteEntry(props.entry.id);
    emit('deleted');
  } catch (err) {
    message.error(errorText(err, '删除失败'));
  }
}

// ---------------- 事实 ----------------
function sourceOf(f: BibleFact): string {
  if (f.chapterId === null) return '作者设定';
  const loc = ws.locate(f.chapterId);
  return loc === null ? '（章节已删除）' : `${loc.volume.title} · ${loc.chapter.title}`;
}

async function addFact(): Promise<void> {
  if (props.entry === null) return;
  if (draft.value.attribute.trim() === '' || draft.value.value.trim() === '') {
    message.warning('请填写属性和值');
    return;
  }
  try {
    await bibleApi.createFact(props.workId, props.entry.id, { ...draft.value });
    draft.value = { attribute: '', value: '', mutable: draft.value.mutable };
    await loadFacts();
  } catch (err) {
    message.error(errorText(err, '添加事实失败'));
  }
}

async function saveFact(): Promise<void> {
  const e = editing.value;
  if (e === null) return;
  try {
    await bibleApi.updateFact(props.workId, e.id, { attribute: e.attribute, value: e.value, mutable: e.mutable });
    editing.value = null;
    await loadFacts();
  } catch (err) {
    message.error(errorText(err, '保存事实失败'));
  }
}

async function deleteFact(f: BibleFact): Promise<void> {
  try {
    await bibleApi.deleteFact(props.workId, f.id);
    await loadFacts();
  } catch (err) {
    message.error(errorText(err, '删除事实失败'));
  }
}
</script>

<template>
  <div class="editor" data-testid="bible-entry-editor">
    <NForm label-placement="left" label-width="56" size="small" :show-feedback="false" class="form">
      <NFormItem label="类型">
        <NSelect v-model:value="form.kind" :options="kindOptions" class="kind" data-testid="entry-kind" />
      </NFormItem>
      <NFormItem label="名称">
        <NInput v-model:value="form.name" placeholder="最完整、最正式的名称" maxlength="100" data-testid="entry-name" />
      </NFormItem>
      <NFormItem label="别名">
        <NDynamicTags v-model:value="form.aliases" :max="50" data-testid="entry-aliases" />
      </NFormItem>
      <NFormItem label="简介">
        <NInput v-model:value="form.summary" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" maxlength="2000" placeholder="一句话说明这是谁 / 是什么" data-testid="entry-summary" />
      </NFormItem>
    </NForm>
    <NSpace size="small" class="actions">
      <NButton type="primary" size="small" :disabled="!dirty" :loading="saving" data-testid="entry-save" @click="save">{{ entry === null ? '新建条目' : '保存' }}</NButton>
      <NPopconfirm v-if="entry" positive-text="删除" negative-text="取消" @positive-click="remove">
        <template #trigger>
          <NButton size="small" quaternary type="error" data-testid="entry-delete">删除条目</NButton>
        </template>
        删除「{{ entry.name }}」及其全部事实？
      </NPopconfirm>
    </NSpace>

    <template v-if="entry">
      <h4 class="facts-title">事实</h4>
      <NEmpty v-if="!factsLoading && facts.length === 0" size="small" description="还没有事实" class="empty" />
      <div v-for="f in facts" :key="f.id" class="fact" data-testid="entry-fact">
        <template v-if="editing?.id === f.id">
          <NInput v-model:value="editing.attribute" size="small" class="attr" />
          <NInput v-model:value="editing.value" size="small" class="value" />
          <NSwitch v-model:value="editing.mutable" size="small"><template #checked>可变</template><template #unchecked>不变</template></NSwitch>
          <NButton size="tiny" type="primary" @click="saveFact">保存</NButton>
          <NButton size="tiny" quaternary @click="editing = null">取消</NButton>
        </template>
        <template v-else>
          <div class="fact-main">
            <span class="fact-attr">{{ f.attribute }}</span>
            <span class="fact-value">{{ f.value }}</span>
            <NTag size="tiny" :bordered="false" :type="f.mutable ? 'warning' : 'default'">{{ f.mutable ? '可变' : '不变' }}</NTag>
            <NText depth="3" class="fact-source">{{ sourceOf(f) }}</NText>
            <span class="spacer" />
            <NButton size="tiny" quaternary @click="editing = { id: f.id, attribute: f.attribute, value: f.value, mutable: f.mutable }">编辑</NButton>
            <NButton size="tiny" quaternary type="error" data-testid="fact-delete" @click="deleteFact(f)">删除</NButton>
          </div>
          <div v-if="f.quote" class="quote">「{{ f.quote }}」</div>
        </template>
      </div>
      <div class="fact add">
        <NInput v-model:value="draft.attribute" size="small" placeholder="属性，如：境界" class="attr" data-testid="fact-attribute" />
        <NInput v-model:value="draft.value" size="small" placeholder="值" class="value" data-testid="fact-value" @keydown.enter="addFact" />
        <NSwitch v-model:value="draft.mutable" size="small"><template #checked>可变</template><template #unchecked>不变</template></NSwitch>
        <NButton size="tiny" secondary type="primary" data-testid="fact-add" @click="addFact">添加</NButton>
      </div>
      <NText depth="3" class="hint">可变：会随剧情变化的属性（境界、位置、伤势、持有物、关系）。一致性检查时只取「截至上一章」的最新值。</NText>
    </template>
  </div>
</template>

<style scoped>
.editor {
  padding: 4px 4px 24px;
}
.form :deep(.n-form-item) {
  margin-bottom: 10px;
}
.kind {
  width: 140px;
}
.actions {
  margin: 4px 0 0 56px;
}
.facts-title {
  margin: 22px 0 8px;
}
.empty {
  margin: 12px 0;
}
.fact {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 4px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.12);
}
.fact.add,
.fact:has(> .attr) {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.fact-main {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.fact-attr {
  font-weight: 600;
  min-width: 56px;
}
.fact-value {
  word-break: break-word;
}
.fact-source {
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.attr {
  width: 120px;
  flex: none;
}
.value {
  flex: 1;
}
.quote {
  font-size: 12px;
  opacity: 0.7;
  padding-left: 64px;
}
.hint {
  display: block;
  font-size: 12px;
  margin-top: 8px;
}
</style>
