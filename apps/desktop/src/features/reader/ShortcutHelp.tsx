import { Dialog } from '@/components/ui';
import { useReader } from '@/stores/readerStore';
import { shortcutGroups } from './shortcuts';

/** 快捷键帮助浮层：? 键唤起，与 shortcuts.ts 共用同一份键表。 */
export function ShortcutHelp() {
  const open = useReader((s) => s.helpOpen);
  const setOpen = useReader((s) => s.setHelpOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="快捷键" subtitle="按 ? 随时唤起这张表" width="max-w-xl">
      <div className="grid grid-cols-2 gap-x-8 gap-y-5">
        {shortcutGroups().map(({ group, items }) => (
          <div key={group}>
            <div className="mb-2 font-serif text-[11px] tracking-widest text-ink-400">{group}</div>
            <ul className="space-y-1.5">
              {items.map((s) => (
                <li key={s.action} className="flex items-baseline justify-between gap-3">
                  <span className="text-[13px] text-ink-700 dark:text-ink-300">{s.label}</span>
                  <span className="flex shrink-0 gap-1">
                    {s.keys.map((k) => (
                      <kbd key={k} className="rounded border border-paper-300 bg-paper-100 px-1.5 py-0.5 font-serif text-[11px] text-ink-600 dark:border-paper-700 dark:bg-paper-800 dark:text-ink-300">{k}</kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-5 text-xs leading-relaxed text-ink-400">另外：按住 Ctrl / ⌘ 滚动鼠标滚轮可以缩放页面。</p>
    </Dialog>
  );
}
