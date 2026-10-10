import { writeAtomic, type AtomicWriter } from '../db';
import { nanoid } from 'nanoid';
import { countZh, sha256Hex } from '@the-water/shared';
import { getDb, now, type AtomicOperation } from '../db';
import { createVersion, getChapter, getVersion, listChapters, type Chapter } from './chaptersRepo';
import { BLOCKING_JOB_STATUSES, listJobs } from './jobsRepo';
import { listWritingCards } from './writingRepo';

async function editable(novelId: string) {
  if ((await listJobs({ novelId, statuses: [...BLOCKING_JOB_STATUSES] })).length)
    throw new Error('请先暂停并取消生成任务，再调整章节结构');
  if (
    (
      await getDb().select("SELECT id FROM chapter_structure_changes WHERE novel_id=? AND state='pending'", [
        novelId,
      ])
    ).length
  )
    throw new Error('请先提交或取消待处理的章节合并');
}
function ordering(chapters: Array<{ id: string; chapterNo: number }>, novelId: string): AtomicOperation[] {
  // Stable chapter IDs keep scene attachments and all historical prose intact.
  return [
    ...chapters.map((c, i) => ({
      sql: 'UPDATE chapters SET chapter_no=? WHERE id=? AND novel_id=? AND chapter_no=? AND archived_at IS NULL',
      params: [-i - 1, c.id, novelId, c.chapterNo],
      expectedRows: 1,
    })),
    ...chapters.map((c, i) => ({
      sql: 'UPDATE chapters SET chapter_no=? WHERE id=?',
      params: [i + 1, c.id],
      expectedRows: 1,
    })),
    {
      sql: "UPDATE writing_cards SET confirmed=0,revision=revision+1 WHERE novel_id=? AND kind IN ('volume','thread','character') AND confirmed=1",
      params: [novelId],
    },
  ];
}
export async function reorderChapters(novelId: string, ids: string[], commit: AtomicWriter = writeAtomic): Promise<void> {
  await editable(novelId);
  const chapters = await listChapters(novelId);
  if (!chapters.length) return;
  if (new Set(ids).size !== chapters.length || ids.some((id) => !chapters.some((c) => c.id === id)))
    throw new Error('章节集合已变化');
  await commit([
    {
      sql: "INSERT INTO chapter_structure_changes(id,novel_id,chapter_id,kind,state,json,created_at) VALUES (?,?,?,'reorder','applied',?,?)",
      params: [nanoid(), novelId, chapters[0]!.id, JSON.stringify(chapters), now()],
    },
    ...ordering(
      ids.map((id) => chapters.find((c) => c.id === id)!),
      novelId,
    ),
  ]);
}
export async function splitChapter(chapterId: string, offset: number, commit: AtomicWriter = writeAtomic): Promise<string> {
  const chapter = await getChapter(chapterId);
  if (!chapter) throw new Error('章节不存在');
  await editable(chapter.novelId);
  const chapters = await listChapters(chapter.novelId);
  if (chapters.length >= 500) throw new Error('章节数量已达 500');
  const version = chapter.currentVersionId ? await getVersion(chapter.currentVersionId) : null;
  const content = version?.content ?? '';
  if (content && (offset <= 0 || offset >= content.length || !Number.isInteger(offset)))
    throw new Error('请选择正文内部的拆分位置');
  const nextId = nanoid(),
    nextVersion = nanoid(),
    t = now(),
    right = content.slice(offset),
    left = content.slice(0, offset);
  const temporaryNo =
    1000000 +
    Number(
      (
        await getDb().select<{ n: number }>(
          'SELECT COUNT(*) AS n FROM chapters WHERE archived_at IS NOT NULL',
        )
      )[0]!.n,
    );
  const insert: AtomicOperation[] = [
    {
      sql: "INSERT INTO chapters(id,novel_id,chapter_no,title,goal,target_chars,pov_character_id,beat_ids,end_hook,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'planned',?)",
      params: [
        nextId,
        chapter.novelId,
        temporaryNo,
        chapter.title,
        chapter.goal,
        Math.ceil(chapter.targetChars / 2),
        chapter.povCharacterId,
        JSON.stringify(chapter.beatIds),
        chapter.endHook,
        t,
      ],
    },
    {
      sql: 'UPDATE chapters SET target_chars=? WHERE id=?',
      params: [Math.floor(chapter.targetChars / 2), chapter.id],
    },
    ...ordering(
      chapters.flatMap((c) =>
        c.id === chapter.id ? [c, { ...c, id: nextId, chapterNo: temporaryNo }] : [c],
      ),
      chapter.novelId,
    ),
    {
      sql: "UPDATE writing_cards SET confirmed=0,revision=revision+1 WHERE chapter_id=? AND kind='scene'",
      params: [chapter.id],
    },
    {
      sql: "INSERT INTO chapter_structure_changes(id,novel_id,chapter_id,kind,state,json,created_at) VALUES (?,?,?,'split','applied',?,?)",
      params: [
        nanoid(),
        chapter.novelId,
        chapter.id,
        JSON.stringify({ before: chapters, sourceVersionId: version?.id, newChapterId: nextId, offset }),
        t,
      ],
    },
  ];
  if (content)
    insert.push(
      {
        sql: "INSERT INTO chapter_versions(id,chapter_id,version_no,content,char_count,source,created_at,state,content_hash) VALUES (?,?,1,?,?,'user_edit',?,'pending',?)",
        params: [nextVersion, nextId, right, countZh(right), t, await sha256Hex(right)],
      },
      {
        sql: "UPDATE chapters SET current_version_id=?,status='draft' WHERE id=?",
        params: [nextVersion, nextId],
      },
    );
  if (version)
    await createVersion({
      commit,
      chapterId,
      content: left,
      source: 'user_edit',
      expectedWorkingVersionId: version.id,
      expectedWorkingHash: version.contentHash,
      atomicTail: insert,
    });
  else await commit(insert);
  return nextId;
}
export async function mergeChapters(firstId: string, secondId: string, commit: AtomicWriter = writeAtomic): Promise<void> {
  const first = await getChapter(firstId),
    second = await getChapter(secondId);
  if (!first || !second || first.novelId !== second.novelId || second.chapterNo !== first.chapterNo + 1)
    throw new Error('只能合并相邻章节');
  await editable(first.novelId);
  const a = first.currentVersionId ? await getVersion(first.currentVersionId) : null,
    b = second.currentVersionId ? await getVersion(second.currentVersionId) : null;
  const id = nanoid();
  const scenes = (await listWritingCards(first.novelId)).filter(
    (c) => c.chapterId === second.id && c.kind === 'scene',
  );
  const sceneCopies = scenes.map((c) => ({ card: c, id: nanoid() }));
  await createVersion({
      commit,
    chapterId: first.id,
    content: [a?.content, b?.content].filter(Boolean).join('\n\n'),
    source: 'user_edit',
    expectedWorkingVersionId: first.currentVersionId,
    expectedWorkingHash: a?.contentHash,
    atomicTail: [
      {
        sql: 'UPDATE chapters SET updated_at=updated_at WHERE id=? AND current_version_id IS ? AND committed_version_id IS ? AND archived_at IS NULL',
        params: [second.id, second.currentVersionId, second.committedVersionId],
        expectedRows: 1,
      },
      {
        sql: "INSERT INTO chapter_structure_changes(id,novel_id,chapter_id,kind,candidate_version_id,json,created_at) VALUES (?,?,?,'merge',(SELECT current_version_id FROM chapters WHERE id=?),?,?)",
        params: [
          id,
          first.novelId,
          first.id,
          first.id,
          JSON.stringify({
            first,
            second,
            secondContent: b?.content ?? null,
            sceneCopies: sceneCopies.map((c) => c.id),
          }),
          now(),
        ],
      },
      {
        sql: 'UPDATE chapters SET goal=?,target_chars=?,end_hook=? WHERE id=?',
        params: [
          [first.goal, second.goal].join('\n'),
          first.targetChars + second.targetChars,
          second.endHook,
          first.id,
        ],
      },
      ...sceneCopies.map(({ card: c, id }) => ({
        sql: 'INSERT INTO writing_cards(id,novel_id,chapter_id,kind,sort_order,revision,confirmed,json,updated_at) VALUES (?,?,?,?,?,1,0,?,?)',
        params: [
          id,
          first.novelId,
          first.id,
          'scene',
          c.order + 1000,
          JSON.stringify({ kind: c.kind, data: c.data }),
          now(),
        ],
      })),
      {
        sql: "UPDATE writing_cards SET confirmed=0,revision=revision+1 WHERE novel_id=? AND kind IN ('volume','thread','character') AND confirmed=1",
        params: [first.novelId],
      },
    ],
  });
}
/** Merged-away prose is archived only in the same transaction that commits its reviewed replacement. */
export async function structureCommitOperations(
  chapter: Chapter,
  versionId: string,
): Promise<AtomicOperation[]> {
  const rows = await getDb().select<{ id: string; json: string; candidate_version_id: string }>(
    "SELECT * FROM chapter_structure_changes WHERE chapter_id=? AND kind='merge' AND state='pending'",
    [chapter.id],
  );
  const ops: AtomicOperation[] = [];
  for (const row of rows) {
    if (row.candidate_version_id !== versionId) throw new Error('合并候选已变化，请重新建立合并计划');
    const payload = JSON.parse(row.json) as { second: Chapter; secondContent: string | null };
    const second = payload.second;
    ops.push(
      {
        sql: 'UPDATE chapters SET archived_at=?,chapter_no=1000000+(SELECT COUNT(*) FROM chapters WHERE archived_at IS NOT NULL) WHERE id=? AND current_version_id IS ? AND committed_version_id IS ? AND archived_at IS NULL AND (SELECT content FROM chapter_versions WHERE id=current_version_id) IS ? AND goal=? AND target_chars=? AND title=? AND end_hook=?',
        params: [
          now(),
          second.id,
          second.currentVersionId,
          second.committedVersionId,
          payload.secondContent,
          second.goal,
          second.targetChars,
          second.title,
          second.endHook,
        ],
        expectedRows: 1,
      },
      {
        sql: "UPDATE chapter_structure_changes SET state='applied' WHERE id=? AND candidate_version_id=? AND state='pending'",
        params: [row.id, versionId],
        expectedRows: 1,
      },
    );
    const remaining = (await listChapters(chapter.novelId)).filter((c) => c.id !== second.id);
    // Subsequent chapters shift down; the committed replacement's own dependencies stay fixed.
    for (const c of remaining.filter((c) => c.chapterNo > second.chapterNo))
      ops.push({ sql: 'UPDATE chapters SET chapter_no=chapter_no-1 WHERE id=?', params: [c.id] });
  }
  return ops;
}

export async function cancelChapterMerge(chapterId: string, commit: AtomicWriter = writeAtomic): Promise<void> {
  const rows = await getDb().select<{ id: string; json: string }>(
    "SELECT id,json FROM chapter_structure_changes WHERE chapter_id=? AND state='pending'",
    [chapterId],
  );
  if (!rows[0]) return;
  const data = JSON.parse(rows[0].json) as { first: Chapter; sceneCopies: string[] };
  const version = data.first.currentVersionId ? await getVersion(data.first.currentVersionId) : null;
  await createVersion({
      commit,
    chapterId,
    content: version?.content ?? '',
    source: 'user_edit',
    cancelStructure: true,
    atomicTail: [
      {
        sql: 'UPDATE chapters SET goal=?,target_chars=?,end_hook=? WHERE id=?',
        params: [data.first.goal, data.first.targetChars, data.first.endHook, chapterId],
      },
      ...data.sceneCopies.map((id) => ({
        sql: 'DELETE FROM writing_cards WHERE id=? AND revision=1 AND confirmed=0',
        params: [id],
      })),
    ],
  });
}
export async function pendingChapterMerges(novelId: string) {
  return getDb().select<{ chapter_id: string }>(
    "SELECT chapter_id FROM chapter_structure_changes WHERE novel_id=? AND state='pending'",
    [novelId],
  );
}
