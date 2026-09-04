/** 字节解文本的统一口径（EPUB 的 XHTML、TXT、Markdown 都走它）。 */

/** 尽量正确地把书稿字节解成文字：先按 UTF-8，失败再试 GBK。 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}
