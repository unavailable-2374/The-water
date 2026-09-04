/**
 * Learning layer (docs/writing/README.md §7 第三期 3): what the user keeps deleting from AI drafts
 * becomes a per-novel negative list. Pure diff helpers here; persistence in db/repos/feedbackRepo.
 */
import type { StyleProfile } from '@the-water/shared';
import { LEARNING } from './config';

/** 阈值与长度都在 `novel/config.ts`；这里只做 re-export，改值改那边。 */
export const PROMOTE_THRESHOLD = LEARNING.promoteThreshold;
const MIN_LEN = LEARNING.minPhraseLen;
const MAX_LEN = LEARNING.maxPhraseLen;

/** Han-only n-grams (2–6) that appear in `before` but nowhere in `after`, with occurrence counts. */
export function removedPhrases(before: string, after: string): Map<string, number> {
  const out = new Map<string, number>();
  const runsBefore = before.split(/[^\p{Script=Han}]+/u).filter(Boolean);
  const afterText = after;
  const seen = new Set<string>();
  for (const run of runsBefore) {
    const cps = Array.from(run);
    for (let n = MAX_LEN; n >= MIN_LEN; n--) {
      for (let i = 0; i + n <= cps.length; i++) {
        const g = cps.slice(i, i + n).join('');
        if (seen.has(g)) continue;
        seen.add(g);
        if (afterText.includes(g)) continue;
        // keep only maximal phrases: skip if a longer already-removed phrase contains it
        let covered = false;
        for (const k of out.keys()) if (k.length > g.length && k.includes(g)) { covered = true; break; }
        if (covered) continue;
        const count = before.split(g).length - 1;
        if (count >= 1) out.set(g, count);
      }
    }
  }
  // drop very generic 2-grams
  for (const k of [...out.keys()]) if (k.length === 2 && /[的了是不在有他她它我你就也都]/.test(k)) out.delete(k);
  return out;
}

/** Merge promoted phrases into the profile's soft negatives (idempotent). */
export function promoteIntoProfile(profile: StyleProfile, phrases: string[]): StyleProfile {
  const list = new Set(profile.negatives.avoidWordsSoft.list);
  for (const p of phrases) if (p.trim()) list.add(p.trim());
  return { ...profile, negatives: { ...profile.negatives, avoidWordsSoft: { ...profile.negatives.avoidWordsSoft, list: [...list].slice(0, LEARNING.softNegativeCap) } } };
}

/** Remove phrases from the profile's soft negatives (用户在「我的写作偏好」里删掉时用)。 */
export function demoteFromProfile(profile: StyleProfile, phrases: readonly string[]): StyleProfile {
  const drop = new Set(phrases.map((p) => p.trim()).filter(Boolean));
  if (drop.size === 0) return profile;
  const list = profile.negatives.avoidWordsSoft.list.filter((w) => !drop.has(w.trim()));
  if (list.length === profile.negatives.avoidWordsSoft.list.length) return profile;
  return { ...profile, negatives: { ...profile.negatives, avoidWordsSoft: { ...profile.negatives.avoidWordsSoft, list } } };
}
