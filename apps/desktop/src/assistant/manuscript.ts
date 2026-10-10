import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import type { AssistantOperation } from '@the-water/shared';
import type { AtomicWriter } from '@/db/db';
import { importTextContent } from '@/novel/importText';
import { NovelRequirementsSchema } from '@/novel/types';
export async function importManuscript(
  id: string,
  input: Extract<AssistantOperation, { name: 'import_manuscript' }>['parameters'],
  commit: AtomicWriter,
  signal: AbortSignal,
) {
  const path = await open({
    multiple: false,
    filters: [{ name: 'Manuscript', extensions: ['txt', 'md'] }],
  });
  if (!path) throw new Error('Import cancelled');
  const text = await readTextFile(path);
  signal.throwIfAborted();
  return importTextContent(
    {
      id,
      title: input.title,
      text,
      requirements: NovelRequirementsSchema.parse(input.requirements),
    },
    commit,
  );
}
