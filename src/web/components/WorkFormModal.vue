<script setup lang="ts">
import { NButton, NForm, NFormItem, NInput, NModal, NSpace, type FormInst, type FormRules } from 'naive-ui';
import { reactive, ref, watch } from 'vue';
import type { CreateWorkRequest, Work } from '../../shared/types';

const props = defineProps<{ show: boolean; work?: Work | null; submitting?: boolean }>();
const emit = defineEmits<{ 'update:show': [boolean]; submit: [CreateWorkRequest] }>();

const form = reactive({ title: '', author: '', genre: '', synopsis: '' });
const formRef = ref<FormInst | null>(null);
const rules: FormRules = {
  title: [{ required: true, whitespace: true, message: '请填写作品名', trigger: ['input', 'blur'] }],
};

watch(
  () => props.show,
  (show) => {
    if (!show) return;
    form.title = props.work?.title ?? '';
    form.author = props.work?.author ?? '';
    form.genre = props.work?.genre ?? '';
    form.synopsis = props.work?.synopsis ?? '';
  },
);

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  emit('submit', { title: form.title.trim(), author: form.author.trim(), genre: form.genre.trim(), synopsis: form.synopsis.trim() });
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :title="work ? '编辑作品信息' : '新建作品'"
    style="width: 520px"
    :mask-closable="false"
    data-testid="work-form"
    @update:show="emit('update:show', $event)"
  >
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="64" @submit.prevent="submit">
      <NFormItem label="作品名" path="title">
        <NInput v-model:value="form.title" maxlength="100" show-count placeholder="例如：青云志" data-testid="work-title" />
      </NFormItem>
      <NFormItem label="作者" path="author">
        <NInput v-model:value="form.author" maxlength="100" placeholder="笔名（可选）" />
      </NFormItem>
      <NFormItem label="类型" path="genre">
        <NInput v-model:value="form.genre" maxlength="100" placeholder="例如：仙侠、都市（可选）" />
      </NFormItem>
      <NFormItem label="简介" path="synopsis">
        <NInput v-model:value="form.synopsis" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" maxlength="2000" placeholder="可选" />
      </NFormItem>
    </NForm>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="emit('update:show', false)">取消</NButton>
        <NButton type="primary" :loading="submitting" data-testid="work-submit" @click="submit">{{ work ? '保存' : '创建' }}</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
