import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/** 复制文本：优先走 Tauri 剪贴板插件，开发时若插件不可用则退回浏览器 API。 */
export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
    return;
  } catch (e) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    throw e;
  }
}
