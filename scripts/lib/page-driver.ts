import { waitForPage, type CdpPage } from './cdp.ts';

/** 浏览器冒烟的页面操作封装：只用 DOM 与 CDP，不依赖任何测试框架。 */
export class PageDriver {
  readonly page: CdpPage;

  constructor(page: CdpPage) {
    this.page = page;
  }

  eval<T>(expression: string): Promise<T> {
    return this.page.evaluate<T>(expression);
  }

  async waitFor(expression: string, message: string, timeoutMs = 8000): Promise<void> {
    if (!(await waitForPage(this.page, expression, timeoutMs))) throw new Error(`等待超时：${message}`);
  }

  async waitText(text: string, timeoutMs = 8000): Promise<void> {
    await this.waitFor(`document.body.innerText.includes(${JSON.stringify(text)})`, `页面出现「${text}」`, timeoutMs);
  }

  async clickTestId(id: string): Promise<void> {
    await this.waitFor(`document.querySelector('[data-testid="${id}"]')`, `元素 ${id}`);
    await this.eval(`document.querySelector('[data-testid="${id}"]').click()`);
  }

  /** 点击 selector 匹配的元素中文字（trim 后）等于 text 的那个。 */
  async clickText(selector: string, text: string): Promise<void> {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
    await this.waitFor(find, `「${text}」(${selector})`);
    await this.eval(`${find}.click()`);
  }

  async focus(selector: string): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  }

  /** 向当前焦点插入文本（等同输入法上屏，会替换选中内容）。 */
  async insertText(text: string): Promise<void> {
    await this.page.send('Input.insertText', { text });
  }

  async press(key: 'Enter' | 'Escape' | 'Backspace'): Promise<void> {
    const code = { Enter: 13, Escape: 27, Backspace: 8 }[key];
    for (const type of ['keyDown', 'keyUp']) {
      await this.page.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
    }
  }

  /** 发送 Ctrl+字母（macOS 上为 Cmd+字母），如撤销 'z'。 */
  async shortcut(letter: string): Promise<void> {
    const upper = letter.toUpperCase();
    const code = upper.charCodeAt(0);
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    for (const type of ['keyDown', 'keyUp']) {
      await this.page.send('Input.dispatchKeyEvent', { type, key: letter, code: `Key${upper}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
    }
    await this.nextFrame();
  }

  /** 模拟输入法组字：依次发送组字中间态，最后上屏 commit（CDP Input.imeSetComposition + insertText）。 */
  async imeType(steps: string[], commit: string): Promise<void> {
    for (const text of steps) {
      await this.page.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    }
    await this.page.send('Input.insertText', { text: commit });
  }

  /** 聚焦 CodeMirror 编辑区，用 Ctrl/Cmd+End（CodeMirror 默认键位 cursorDocEnd）把光标移到文末。 */
  async focusEditorEnd(): Promise<void> {
    await this.waitFor(`document.querySelector('.cm-content')`, '编辑器');
    await this.eval(`document.querySelector('.cm-content').focus()`);
    const modifiers = process.platform === 'darwin' ? 4 : 2;
    for (const type of ['keyDown', 'keyUp']) {
      await this.page.send('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers });
    }
    await this.nextFrame();
  }

  /** 在视口坐标处发送一次真实的鼠标左键点击（CDP Input.dispatchMouseEvent）。 */
  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  /** 给 <input type="file"> 设置本地文件或目录（CDP DOM.setFileInputFiles，会触发 change 事件）。 */
  async setInputFiles(selector: string, paths: string[]): Promise<void> {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, selector);
    const { root } = await this.page.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    const { nodeId } = await this.page.send<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector });
    await this.page.send('DOM.setFileInputFiles', { nodeId, files: paths });
  }

  async nextFrame(): Promise<void> {
    await this.eval(`new Promise(r => requestAnimationFrame(() => r(1)))`);
  }

  async fetchJson<T>(path: string): Promise<T> {
    return this.eval<T>(`fetch(${JSON.stringify(path)}).then(r => r.json())`);
  }

  async fetchText(path: string): Promise<string> {
    return this.eval<string>(`fetch(${JSON.stringify(path)}).then(r => r.text())`);
  }

  async screenshot(): Promise<Buffer> {
    const shot = await this.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(shot.data, 'base64');
  }

  async navigate(url: string): Promise<void> {
    await this.page.send('Page.navigate', { url });
  }
}
