import { getDb, now } from '../db';
import { PROMOTE_THRESHOLD, demoteFromProfile, promoteIntoProfile, removedPhrases } from '@/novel/learning';
import { getStyleExtras, setStyleProfile } from './storylineRepo';
import { emptyStyleProfile, type StyleProfile } from '@the-water/shared';

export interface FeedbackRow { phrase: string; count: number; promoted: boolean }

/** 晋升还差几次（供「我的写作偏好」面板显示）。 */
export const FEEDBACK_PROMOTE_THRESHOLD = PROMOTE_THRESHOLD;

/** Record phrases the user deleted from an AI draft; returns phrases newly promoted into the profile. */
export async function recordUserEdit(novelId: string, aiText: string, userText: string): Promise<string[]> {
  const removed = removedPhrases(aiText, userText);
  if (removed.size === 0) return [];
  const db = getDb();
  const t = now();
  for (const [phrase, count] of removed) {
    await db.execute(
      'INSERT INTO style_feedback(novel_id, phrase, count, promoted, updated_at) VALUES (?,?,?,0,?) ON CONFLICT(novel_id, phrase) DO UPDATE SET count = count + excluded.count, updated_at = excluded.updated_at',
      [novelId, phrase, count, t],
    );
  }
  return promotePending(novelId);
}

export async function listFeedback(novelId: string): Promise<FeedbackRow[]> {
  const rows = await getDb().select<{ phrase: string; count: number; promoted: number }>('SELECT phrase, count, promoted FROM style_feedback WHERE novel_id = ? ORDER BY count DESC, updated_at DESC LIMIT 200', [novelId]);
  return rows.map((r) => ({ phrase: r.phrase, count: r.count, promoted: r.promoted === 1 }));
}

/** Phrases at/over threshold go into the novel's profile negatives (soft list). */
export async function promotePending(novelId: string): Promise<string[]> {
  const rows = await getDb().select<{ phrase: string }>('SELECT phrase FROM style_feedback WHERE novel_id = ? AND promoted = 0 AND count >= ? AND length(phrase) >= 2', [novelId, PROMOTE_THRESHOLD]);
  const phrases = rows.map((r) => r.phrase);
  if (phrases.length === 0) return [];
  const { styleProfile } = await getStyleExtras(novelId);
  const next = promoteIntoProfile(styleProfile ?? emptyStyleProfile({ id: 'learned', name: '从修改中学到的' }), phrases);
  await setStyleProfile(novelId, next);
  for (const p of phrases) await getDb().execute('UPDATE style_feedback SET promoted = 1 WHERE novel_id = ? AND phrase = ?', [novelId, p]);
  return phrases;
}

export async function forgetFeedback(novelId: string, phrase: string): Promise<void> {
  await getDb().execute('DELETE FROM style_feedback WHERE novel_id = ? AND phrase = ?', [novelId, phrase]);
}

// ---------------------------------------------------------------------------
// 「我的写作偏好」面板用的三个动作（§2.3 第 1 条）
// ---------------------------------------------------------------------------

const profileOf = async (novelId: string): Promise<StyleProfile> =>
  (await getStyleExtras(novelId)).styleProfile ?? emptyStyleProfile({ id: 'learned', name: '从修改中学到的' });

/**
 * 手动晋升一条短语：不看出现次数，直接写进作品的「少用词」。
 * 用户在面板里点「用起来」时调用。
 */
export async function promoteFeedback(novelId: string, phrase: string): Promise<void> {
  const p = phrase.trim();
  if (!p) return;
  await setStyleProfile(novelId, promoteIntoProfile(await profileOf(novelId), [p]));
  await getDb().execute(
    'INSERT INTO style_feedback(novel_id, phrase, count, promoted, updated_at) VALUES (?,?,1,1,?) ON CONFLICT(novel_id, phrase) DO UPDATE SET promoted = 1, updated_at = excluded.updated_at',
    [novelId, p, now()],
  );
}

/**
 * 忘掉一条短语：从学习记录里删掉，并把它从作品的「少用词」里摘出来。
 * 用户在面板里点「删掉」时调用 —— 只删记录不摘清单的话，用户会觉得删了没用。
 */
export async function dismissFeedback(novelId: string, phrase: string): Promise<void> {
  const p = phrase.trim();
  if (!p) return;
  await forgetFeedback(novelId, p);
  const profile = (await getStyleExtras(novelId)).styleProfile;
  if (!profile) return;
  const next = demoteFromProfile(profile, [p]);
  if (next !== profile) await setStyleProfile(novelId, next);
}

/** 清空这本书学到的全部短语（连同已进清单的那些）。 */
export async function clearFeedback(novelId: string): Promise<void> {
  const rows = await listFeedback(novelId);
  await getDb().execute('DELETE FROM style_feedback WHERE novel_id = ?', [novelId]);
  const profile = (await getStyleExtras(novelId)).styleProfile;
  if (!profile || rows.length === 0) return;
  const next = demoteFromProfile(profile, rows.map((r) => r.phrase));
  if (next !== profile) await setStyleProfile(novelId, next);
}
