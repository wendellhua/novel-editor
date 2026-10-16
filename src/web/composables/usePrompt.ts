import { NInput, useDialog } from 'naive-ui';
import { h, nextTick, ref } from 'vue';

export interface PromptOptions {
  title: string;
  initial?: string;
  placeholder?: string;
  positiveText?: string;
  maxlength?: number;
}

export interface ConfirmOptions {
  title: string;
  content: string;
  positiveText?: string;
  danger?: boolean;
}

/** 基于 Naive UI 对话框的输入框与确认框（Promise 风格）。必须在 NDialogProvider 内的组件 setup 中调用。 */
export function usePrompt() {
  const dialog = useDialog();

  function prompt(options: PromptOptions): Promise<string | null> {
    const value = ref(options.initial ?? '');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const d = dialog.create({
        title: options.title,
        showIcon: false,
        positiveText: options.positiveText ?? '确定',
        negativeText: '取消',
        content: () =>
          h(NInput, {
            value: value.value,
            placeholder: options.placeholder,
            maxlength: options.maxlength ?? 100,
            showCount: true,
            autofocus: true,
            'onUpdate:value': (v: string) => (value.value = v),
            onKeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.isComposing && value.value.trim() !== '') {
                d.destroy();
                finish(value.value.trim());
              }
            },
          }),
        onPositiveClick: () => {
          if (value.value.trim() === '') return false;
          finish(value.value.trim());
          return true;
        },
        onNegativeClick: () => finish(null),
        onClose: () => finish(null),
        onMaskClick: () => finish(null),
        onAfterLeave: () => finish(null),
      });
      void nextTick(() => {
        const input = document.querySelector<HTMLInputElement>('.n-dialog input');
        input?.focus();
        input?.select();
      });
    });
  }

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      (options.danger === true ? dialog.warning : dialog.info)({
        title: options.title,
        content: options.content,
        positiveText: options.positiveText ?? '确定',
        negativeText: '取消',
        onPositiveClick: () => finish(true),
        onNegativeClick: () => finish(false),
        onClose: () => finish(false),
        onMaskClick: () => finish(false),
        onAfterLeave: () => finish(false),
      });
    });
  }

  return { prompt, confirm };
}
