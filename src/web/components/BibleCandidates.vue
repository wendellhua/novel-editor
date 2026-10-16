<script setup lang="ts">
import { NButton, NDynamicTags, NEmpty, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSpace, NSwitch, NTag, NText, useDialog, useMessage } from 'naive-ui';
import { computed, ref } from 'vue';
import { ENTRY_KINDS } from '../../shared/constants';
import type { BibleCandidate, CandidateDecision, CandidatePayload, NewAliasPayload, NewEntryPayload, NewFactPayload } from '../../shared/types';
import { ApiError } from '../api/client';
import { useBibleStore, type CandidateGroup } from '../stores/bible';
import { useWorkspaceStore } from '../stores/workspace';
import { CANDIDATE_OP_LABELS, ENTRY_KIND_LABELS } from '../utils/labels';

/** 待审核候选（F5 第 3 步）：按条目分组、按出现次数排序；逐条或整组接受、编辑后接受、合并到已有条目、拒绝。 */
const emit = defineEmits<{ extract: [] }>();
const bible = useBibleStore();
const ws = useWorkspaceStore();
const message = useMessage();
const dialog = useDialog();
const busy = ref(false);

/** 一次最多渲染多少组（首次抽取百万字作品时候选很多）。 */
const MAX_GROUPS = 200;

const entryOptions = computed(() => bible.entries.map((e) => ({ label: `${e.name}（${ENTRY_KIND_LABELS[e.kind]}）`, value: e.id })));
const kindOptions = ENTRY_KINDS.map((k) => ({ label: ENTRY_KIND_LABELS[k], value: k }));

const asEntry = (c: BibleCandidate): NewEntryPayload => c.payload as NewEntryPayload;
const asFact = (c: BibleCandidate): NewFactPayload => c.payload as NewFactPayload;
const asAlias = (c: BibleCandidate): NewAliasPayload => c.payload as NewAliasPayload;

function chapterOf(c: BibleCandidate): string {
  const loc = ws.locate(c.chapterId);
  return loc === null ? '（章节已删除）' : `${loc.volume.title} · ${loc.chapter.title}`;
}

async function run(decisions: CandidateDecision[], group: CandidateGroup | null = null): Promise<void> {
  if (decisions.length === 0) return;
  busy.value = true;
  try {
    const r = await bible.decide(decisions);
    const parts = [r.accepted > 0 ? `接受 ${r.accepted} 条` : '', r.rejected > 0 ? `拒绝 ${r.rejected} 条` : ''].filter(Boolean);
    if (parts.length > 0) message.success(`已${parts.join('、')}`);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NAME_CONFLICT' && typeof err.details.entryId === 'string') {
      const entryId = err.details.entryId;
      const entryName = String(err.details.entryName ?? '');
      const ids = group !== null ? group.items.map((c) => c.id) : decisions.map((d) => d.id);
      dialog.warning({
        title: '名称与已有条目冲突',
        content: err.message,
        positiveText: `合并到「${entryName}」`,
        negativeText: '取消',
        onPositiveClick: () => run(ids.map((id) => ({ id, action: 'merge', mergeIntoEntryId: entryId }))),
      });
    } else {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    }
  } finally {
    busy.value = false;
  }
}

const acceptGroup = (g: CandidateGroup): Promise<void> => run(g.items.map((c) => ({ id: c.id, action: 'accept' })), g);
const rejectGroup = (g: CandidateGroup): Promise<void> => run(g.items.map((c) => ({ id: c.id, action: 'reject' })));
const mergeGroup = (g: CandidateGroup, entryId: string): Promise<void> => run(g.items.map((c) => ({ id: c.id, action: 'merge', mergeIntoEntryId: entryId })));
/** 全部接受：与已有条目同名的新条目组改为合并到该条目。 */
const acceptAll = (): Promise<void> =>
  run(
    bible.groups.flatMap((g) =>
      g.items.map((c): CandidateDecision => (g.conflictEntry !== null ? { id: c.id, action: 'merge', mergeIntoEntryId: g.conflictEntry.id } : { id: c.id, action: 'accept' })),
    ),
  );

// ---------------- 编辑后接受 ----------------
const editing = ref<{ candidate: BibleCandidate; payload: CandidatePayload } | null>(null);
function edit(c: BibleCandidate): void {
  editing.value = { candidate: c, payload: JSON.parse(JSON.stringify(c.payload)) as CandidatePayload };
}
async function acceptEdited(): Promise<void> {
  const e = editing.value;
  if (e === null) return;
  editing.value = null;
  await run([{ id: e.candidate.id, action: 'accept', payload: e.payload }]);
}
const editEntry = computed(() => editing.value?.payload as NewEntryPayload);
const editFact = computed(() => editing.value?.payload as NewFactPayload);
const editAlias = computed(() => editing.value?.payload as NewAliasPayload);
</script>

<template>
  <div class="candidates" data-testid="bible-candidates">
    <div class="toolbar">
      <NButton size="small" type="primary" secondary data-testid="bible-extract" @click="emit('extract')">AI 抽取设定</NButton>
      <NPopconfirm v-if="bible.candidates.length > 0" positive-text="全部接受" negative-text="取消" @positive-click="acceptAll">
        <template #trigger>
          <NButton size="small" :loading="busy" data-testid="candidates-accept-all">全部接受（{{ bible.candidates.length }}）</NButton>
        </template>
        接受全部 {{ bible.candidates.length }} 条候选？与已有条目同名的会合并到该条目。
      </NPopconfirm>
      <NText depth="3" class="hint">按条目分组，出现次数多的在前。接受后才会进入设定库，作为一致性检查的基准。</NText>
    </div>
    <NEmpty v-if="bible.candidates.length === 0" description="没有待审核的候选" class="empty">
      <template #extra>
        <NText depth="3" class="hint">点击「AI 抽取设定」，从正文中抽取人物、地点、势力等设定，审核后入库</NText>
      </template>
    </NEmpty>

    <section v-for="g in bible.groups.slice(0, MAX_GROUPS)" :key="g.key" class="group" data-testid="candidate-group" :data-group-name="g.name">
      <header class="group-head">
        <span class="group-name">{{ g.name }}</span>
        <NTag v-if="g.entry" size="small" :bordered="false" type="info">已有条目</NTag>
        <NTag v-else-if="g.conflictEntry" size="small" :bordered="false" type="warning">与已有条目同名</NTag>
        <NTag v-else size="small" :bordered="false" type="success">新条目</NTag>
        <NText depth="3" class="count">出现 {{ g.items.length }} 次</NText>
        <span class="spacer" />
        <NButton v-if="g.conflictEntry" size="tiny" type="primary" :disabled="busy" data-testid="group-merge-conflict" @click="mergeGroup(g, g.conflictEntry.id)">
          合并到「{{ g.conflictEntry.name }}」
        </NButton>
        <NButton v-else size="tiny" type="primary" :disabled="busy" data-testid="group-accept" @click="acceptGroup(g)">接受全部</NButton>
        <NSelect
          v-if="!g.entry"
          size="tiny"
          class="merge"
          :options="entryOptions"
          placeholder="合并到…"
          filterable
          :value="null"
          data-testid="group-merge"
          @update:value="(id: string) => mergeGroup(g, id)"
        />
        <NButton size="tiny" quaternary :disabled="busy" data-testid="group-reject" @click="rejectGroup(g)">全部拒绝</NButton>
      </header>
      <div v-for="c in g.items" :key="c.id" class="item" data-testid="candidate-item" :data-op="c.op">
        <div class="item-main">
          <NTag size="tiny" :bordered="false">{{ CANDIDATE_OP_LABELS[c.op] }}</NTag>
          <template v-if="c.op === 'new_entry'">
            <span class="kind">{{ ENTRY_KIND_LABELS[asEntry(c).kind] }}</span>
            <span v-if="asEntry(c).aliases.length > 0" class="aliases">别名：{{ asEntry(c).aliases.join('、') }}</span>
            <span v-if="asEntry(c).summary" class="summary">{{ asEntry(c).summary }}</span>
          </template>
          <span v-else-if="c.op === 'new_fact'" class="fact">
            <b>{{ asFact(c).attribute }}</b>：{{ asFact(c).value }}
            <NTag size="tiny" :bordered="false" :type="asFact(c).mutable ? 'warning' : 'default'">{{ asFact(c).mutable ? '可变' : '不变' }}</NTag>
          </span>
          <span v-else class="fact">{{ asAlias(c).alias }}</span>
          <span class="spacer" />
          <NButton size="tiny" quaternary :disabled="busy" data-testid="candidate-accept" @click="run([{ id: c.id, action: 'accept' }], g.entry ? null : g)">接受</NButton>
          <NButton size="tiny" quaternary :disabled="busy" data-testid="candidate-edit" @click="edit(c)">编辑</NButton>
          <NButton size="tiny" quaternary :disabled="busy" data-testid="candidate-reject" @click="run([{ id: c.id, action: 'reject' }])">拒绝</NButton>
        </div>
        <ul v-if="c.op === 'new_entry' && asEntry(c).facts.length > 0" class="facts">
          <li v-for="(f, i) in asEntry(c).facts" :key="i">
            <b>{{ f.attribute }}</b>：{{ f.value }}<NText depth="3">{{ f.mutable ? '（可变）' : '' }}</NText>
          </li>
        </ul>
        <div class="quote"><NText depth="3">{{ chapterOf(c) }}</NText>「{{ c.quote }}」</div>
      </div>
    </section>
    <NText v-if="bible.groups.length > MAX_GROUPS" depth="3" class="hint">只显示前 {{ MAX_GROUPS }} 组，处理后会继续显示其余候选</NText>

    <NModal :show="editing !== null" preset="card" title="编辑后接受" class="edit-modal" :style="{ width: '520px' }" @update:show="(v: boolean) => !v && (editing = null)">
      <NForm v-if="editing" label-placement="left" label-width="56" size="small" :show-feedback="false" class="form">
        <template v-if="editing.candidate.op === 'new_entry'">
          <NFormItem label="类型"><NSelect v-model:value="editEntry.kind" :options="kindOptions" /></NFormItem>
          <NFormItem label="名称"><NInput v-model:value="editEntry.name" data-testid="edit-name" /></NFormItem>
          <NFormItem label="别名"><NDynamicTags v-model:value="editEntry.aliases" /></NFormItem>
          <NFormItem label="简介"><NInput v-model:value="editEntry.summary" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" /></NFormItem>
          <NFormItem label="事实">
            <div class="edit-facts">
              <div v-for="(f, i) in editEntry.facts" :key="i" class="edit-fact">
                <NInput v-model:value="f.attribute" size="small" class="attr" />
                <NInput v-model:value="f.value" size="small" />
                <NSwitch v-model:value="f.mutable" size="small"><template #checked>可变</template><template #unchecked>不变</template></NSwitch>
                <NButton size="tiny" quaternary type="error" @click="editEntry.facts.splice(i, 1)">去掉</NButton>
              </div>
            </div>
          </NFormItem>
        </template>
        <template v-else-if="editing.candidate.op === 'new_fact'">
          <NFormItem label="属性"><NInput v-model:value="editFact.attribute" /></NFormItem>
          <NFormItem label="值"><NInput v-model:value="editFact.value" /></NFormItem>
          <NFormItem label="可变"><NSwitch v-model:value="editFact.mutable" /></NFormItem>
        </template>
        <NFormItem v-else label="别名"><NInput v-model:value="editAlias.alias" /></NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton size="small" @click="editing = null">取消</NButton>
          <NButton size="small" type="primary" data-testid="edit-accept" @click="acceptEdited">接受</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.hint {
  font-size: 12px;
}
.empty {
  margin-top: 48px;
}
.group {
  border: 1px solid rgba(127, 127, 127, 0.18);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
}
.group-name {
  font-weight: 600;
  font-size: 15px;
}
.count {
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.merge {
  width: 150px;
}
.item {
  padding: 6px 0;
  border-top: 1px dashed rgba(127, 127, 127, 0.18);
  font-size: 13px;
}
.item-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kind,
.aliases {
  opacity: 0.8;
}
.summary {
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.facts {
  margin: 4px 0 0;
  padding-left: 22px;
}
.quote {
  margin-top: 3px;
  font-size: 12px;
  opacity: 0.75;
}
.edit-facts {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.edit-fact {
  display: flex;
  align-items: center;
  gap: 6px;
}
.attr {
  width: 110px;
  flex: none;
}
</style>
