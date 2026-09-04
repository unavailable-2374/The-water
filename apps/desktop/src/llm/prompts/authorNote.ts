/**
 * 「作者附加指令」（§2.3 第 6 条后半）：为单本小说追加一段自己的话，
 * 拼进每一次写作 / 改写 / 调长的 system 提示里。
 *
 * 存在 settings 表的 `authorNote:<novelId>` 键（不动 novels 表，免迁移）。
 * `systemBase` 是同步函数，所以这里额外维护一份内存缓存：
 * 任务开始前 `primeAuthorNote(novelId)` 预热一次，之后 `authorNoteOf(novelId)` 同步取用。
 */

/** 单条附加指令的长度上限；再长就会挤掉真正的创作要求。 */
export const AUTHOR_NOTE_MAX_CHARS = 1200;

const KEY = (novelId: string) => `authorNote:${novelId}`;
const cache = new Map<string, string>();

function clip(note: string): string {
  const cps = Array.from(note.trim());
  return cps.length <= AUTHOR_NOTE_MAX_CHARS ? cps.join('') : cps.slice(0, AUTHOR_NOTE_MAX_CHARS).join('');
}

/** 读取并写入缓存（UI 与任务都走这一条）。 */
export async function loadAuthorNote(novelId: string): Promise<string> {
  const { getSetting } = await import('@/db/repos/settingsRepo');
  const note = clip(await getSetting<string>(KEY(novelId), ''));
  cache.set(novelId, note);
  return note;
}

export async function saveAuthorNote(novelId: string, note: string): Promise<string> {
  const { setSetting } = await import('@/db/repos/settingsRepo');
  const next = clip(note);
  await setSetting(KEY(novelId), next);
  cache.set(novelId, next);
  return next;
}

/** 任务开始前预热缓存，让同步的 `styleExtrasOf` / `systemBase` 能取到。 */
export async function primeAuthorNote(novelId: string): Promise<string> {
  return loadAuthorNote(novelId);
}

/** 同步取用；没预热过就返回空串（宁可不加，也不要卡住提示词组装）。 */
export function authorNoteOf(novelId: string): string {
  return cache.get(novelId) ?? '';
}

/** 测试与「切换小说」时清缓存。 */
export function clearAuthorNoteCache(novelId?: string): void {
  if (novelId) cache.delete(novelId);
  else cache.clear();
}

/** 渲染成 system 提示里的一节；空则返回空串。 */
export function renderAuthorNote(note: string | null | undefined): string {
  const n = (note ?? '').trim();
  return n ? `【作者附加指令】（优先级高于上面的通用要求）\n${clip(n)}` : '';
}
