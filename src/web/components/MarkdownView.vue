<script setup lang="ts">
import { computed } from 'vue';
import { parseMarkdown } from '../utils/markdown';

/** 审稿报告的只读渲染：块结构来自 parseMarkdown，文字一律作为文本节点输出（不使用 v-html）。 */
const props = defineProps<{ source: string }>();
const blocks = computed(() => parseMarkdown(props.source));
</script>

<template>
  <div class="md" data-testid="markdown">
    <template v-for="(b, i) in blocks" :key="i">
      <component :is="`h${b.level + 2 > 6 ? 6 : b.level + 2}`" v-if="b.kind === 'heading'" class="md-h" :class="`md-h${b.level}`">
        <template v-for="(s, k) in b.inlines" :key="k"><strong v-if="s.bold">{{ s.text }}</strong><template v-else>{{ s.text }}</template></template>
      </component>
      <component :is="b.ordered ? 'ol' : 'ul'" v-else-if="b.kind === 'list'" class="md-list">
        <li v-for="(item, j) in b.items" :key="j">
          <template v-for="(s, k) in item" :key="k"><strong v-if="s.bold">{{ s.text }}</strong><template v-else>{{ s.text }}</template></template>
        </li>
      </component>
      <p v-else class="md-p">
        <template v-for="(s, k) in b.inlines" :key="k"><strong v-if="s.bold">{{ s.text }}</strong><template v-else>{{ s.text }}</template></template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.md {
  font-size: 14px;
  line-height: 1.8;
  word-break: break-word;
}
.md-h {
  margin: 14px 0 6px;
  font-weight: 600;
  line-height: 1.5;
}
.md-h1 {
  font-size: 18px;
}
.md-h2 {
  font-size: 16px;
}
.md-h3,
.md-h4 {
  font-size: 15px;
}
.md-p {
  margin: 6px 0;
  white-space: pre-wrap;
}
.md-list {
  margin: 6px 0;
  padding-left: 1.6em;
}
.md-list li {
  white-space: pre-wrap;
  margin: 2px 0;
}
.md > :first-child {
  margin-top: 0;
}
</style>
