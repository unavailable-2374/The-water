import { z } from 'zod';
import { anchorEvidence, type ReviewIssue } from '@the-water/shared';
import { ChangeSet } from '@codemirror/state';
import { sha256Hex, type TextProposal } from '@the-water/shared';

/** Conservative mapping: only a provably non-overlapping contiguous edit can be rebased. */
export function relocateProposal(
  proposal: TextProposal,
  base: string,
  current: string,
): { from: number; to: number } | null {
  if (
    base.slice(proposal.from, proposal.to) !== proposal.original ||
    proposal.to < proposal.from ||
    proposal.to > base.length
  )
    return null;
  if (base === current) return { from: proposal.from, to: proposal.to };
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(base.length, current.length) && base[prefix] === current[prefix]) prefix++;
  while (
    suffix < base.length - prefix &&
    suffix < current.length - prefix &&
    base[base.length - 1 - suffix] === current[current.length - 1 - suffix]
  )
    suffix++;
  const end = base.length - suffix;
  if (prefix <= proposal.to && end >= proposal.from) return null;
  const changes = ChangeSet.of(
    { from: prefix, to: end, insert: current.slice(prefix, current.length - suffix) },
    base.length,
  );
  const from = changes.mapPos(proposal.from, 1),
    to = changes.mapPos(proposal.to, -1);
  return current.slice(from, to) === proposal.original ? { from, to } : null;
}
export async function applyTextProposal(
  proposal: TextProposal,
  base: string,
  current: string,
): Promise<string> {
  if ((await sha256Hex(base)) !== proposal.baseHash) throw new Error('建议的基础版本已变化');
  const range = relocateProposal(proposal, base, current);
  if (!range) throw new Error('建议与当前编辑冲突，候选已保留，请重新生成或人工合并');
  return current.slice(0, range.from) + proposal.replacement + current.slice(range.to);
}

export const RevisionPatchesSchema = z.object({
  patches: z
    .array(
      z.object({
        from: z.number().int().min(0),
        to: z.number().int().min(0),
        original: z.string().min(1),
        replacement: z.string(),
      }),
    )
    .max(80),
});
/** TESTABLE invariant: untouched prose is copied verbatim; overlapping/remote patches fail. */
export function applyRevisionPatches(
  original: string,
  patches: z.infer<typeof RevisionPatchesSchema>['patches'],
  issues: ReviewIssue[],
) {
  const anchored = patches
    .map((p) => ({ ...p, ...anchorEvidence(original, { from: p.from, to: p.to, quote: p.original }) }))
    .sort((a, b) => a.from - b.from);
  for (const [i, p] of anchored.entries()) {
    if (i > 0 && anchored[i - 1]!.to > p.from) throw new Error('局部修订范围重叠');
    if (p.from === 0 && p.to === original.length) throw new Error('局部修订不能替换整章');
    if (!issues.some((issue) => p.from < issue.evidence.to && p.to > issue.evidence.from))
      throw new Error(`修订范围没有覆盖已定位问题：${p.from}–${p.to}「${p.original.slice(0,120)}」。允许的证据范围为 ${issues.map(issue=>`${issue.evidence.from}–${issue.evidence.to}`).join('、')}。请将必要的衔接修改合并进覆盖证据的连续局部补丁（保留中间无关原文），或移除此独立补丁留待下一轮审查。`);
  }
  let text = original;
  for (const p of [...anchored].reverse()) text = text.slice(0, p.from) + p.replacement + text.slice(p.to);
  return { text, patches: anchored.map(({ quote: _quote, ...p }) => p) };
}
