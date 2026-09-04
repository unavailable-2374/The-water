import { getDb, now } from '../db';
import { PROMOTE_THRESHOLD, promoteIntoProfile, removedPhrases } from '@/novel/learning';
import { getStyleExtras, setStyleProfile } from './storylineRepo';
import { emptyStyleProfile } from '@the-water/shared';

export interface FeedbackRow { phrase: string; count: number; promoted: boolean }

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
