<script setup lang="ts">
import { NButton, NModal, NSpace, NText } from 'naive-ui';
import { countWords } from '../../shared/text';

defineProps<{
  show: boolean;
  title: string;
  description: string;
  leftLabel: string;
  left: string;
  leftAction: string;
  rightLabel: string;
  right: string;
  rightAction: string;
}>();
const emit = defineEmits<{ choose: ['left' | 'right'] }>();
</script>

<template>
  <NModal :show="show" preset="card" :title="title" style="width: min(1100px, 94vw)" :closable="false" :mask-closable="false" data-testid="compare-modal">
    <NText depth="2">{{ description }}</NText>
    <div class="cols">
      <section>
        <header>{{ leftLabel }}（{{ countWords(left) }} 字）</header>
        <pre data-testid="compare-left">{{ left }}</pre>
      </section>
      <section>
        <header>{{ rightLabel }}（{{ countWords(right) }} 字）</header>
        <pre data-testid="compare-right">{{ right }}</pre>
      </section>
    </div>
    <template #footer>
      <NSpace justify="end">
        <NButton data-testid="compare-right-action" @click="emit('choose', 'right')">{{ rightAction }}</NButton>
        <NButton type="primary" data-testid="compare-left-action" @click="emit('choose', 'left')">{{ leftAction }}</NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 12px;
}
header {
  font-weight: 600;
  margin-bottom: 6px;
}
pre {
  white-space: pre-wrap;
  font-family: inherit;
  max-height: 55vh;
  overflow: auto;
  margin: 0;
  padding: 12px;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.08);
  line-height: 1.7;
}
</style>
