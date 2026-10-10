import { nanoid } from 'nanoid';
import { countZh, emptyBible, sha256Hex, splitChapters } from '@the-water/shared';
import { now, writeAtomic, type AtomicOperation, type AtomicWriter } from '@/db/db';
import { getNovel } from '@/db/repos/novelsRepo';
import { NovelRequirementsSchema, type NovelRequirements } from './types';
/** Shared by the import page and assistant: partial manuscripts cannot leak through failed imports. */
export async function importTextContent(
  input: { id?: string; title: string; text: string; requirements: NovelRequirements },
  commit: AtomicWriter = writeAtomic,
) {
  if (!input.text.trim()) throw new Error('Manuscript is empty');
  const parts = splitChapters(input.text);
  if (!parts.length || parts.length > 500)
    throw new Error('Manuscript must contain 1–500 chapters');
  const id = input.id ?? nanoid(),
    time = now();
  const ops: AtomicOperation[] = [
    {
      sql: "INSERT INTO novels(id,title,premise,requirements,target_chars,status,created_at,updated_at) VALUES (?,?,'',?,?,'writing',?,?)",
      params: [
        id,
        input.title,
        JSON.stringify(NovelRequirementsSchema.parse(input.requirements)),
        parts.reduce((s, p) => s + p.content.length, 0),
        time,
        time,
      ],
    },
  ];
  for (const [i, part] of parts.entries()) {
    const chapterId = nanoid(),
      versionId = nanoid(),
      hash = await sha256Hex(part.content);
    ops.push(
      {
        sql: "INSERT INTO chapters(id,novel_id,chapter_no,title,target_chars,status,current_version_id,committed_version_id,memory_status,updated_at) VALUES (?,?,?,?,?,'final',?,?,'legacy',?)",
        params: [chapterId, id, i + 1, part.title, part.content.length, versionId, versionId, time],
      },
      {
        sql: "INSERT INTO chapter_versions(id,chapter_id,version_no,content,char_count,source,created_at,state,content_hash,committed_at) VALUES (?,?,1,?,?,'imported',?,'accepted',?,?)",
        params: [versionId, chapterId, part.content, countZh(part.content), time, hash, time],
      },
      {
        sql: "INSERT INTO chapter_commits(id,chapter_id,version_id,content_hash,dependency_hash,kind,created_at) VALUES (?,?,?,?,'','legacy',?)",
        params: [nanoid(), chapterId, versionId, hash, time],
      },
    );
  }
  ops.push({
    sql: 'INSERT INTO story_bible_snapshots(id,novel_id,after_chapter_no,json,created_at) VALUES (?,?,0,?,?)',
    params: [nanoid(), id, JSON.stringify(emptyBible()), time],
  });
  await commit(ops);
  return (await getNovel(id))!;
}
