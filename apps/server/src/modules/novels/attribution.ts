/**
 * 机器可读署名块（§3.7）。
 *
 * 谁在用它：
 * - `GET /novels/:id/attribution` —— 网页作品页与桌面端作品页展示许可全文链接、非商业提示、原作署名；
 * - `NovelBundleV1.attribution` —— bundle 与由 bundle 生成的导出文件都自带署名，离线也不丢；
 * - 桌面端二创发布前的「必须展示的原作署名」面板。
 *
 * 一个刻意的取舍：链条上的祖先即使当前不可公开访问（下架 / 审核隐藏），
 * 也仍然保留真实标题与作者名 —— 署名是许可要求的义务，不能因为原作下架就抹掉；
 * 但 `url` 会置空、`available` 置 false，客户端据此不给出链接。
 */
import { eq } from 'drizzle-orm';
import {
  ATTRIBUTION_SPEC,
  attributionNotice,
  licenseMeta,
  type Attribution,
  type AttributionParty,
} from '@the-water/shared';
import type { AppDeps } from '../../context';
import { novelVersions, type NovelRow } from '../../db/schema';
import { iso } from '../../lib/time';
import { novelShareUrl } from '../../lib/urls';
import { toAuthorCard } from './dto';
import { authorOf, canView, findNovelRow, isPubliclyViewable, type Viewer } from './service';

/** 祖先链最多回溯这么多层，与 lineage.ts 的 MAX_ANCESTORS 保持一致。 */
export const MAX_ATTRIBUTION_DEPTH = 64;

function versionNumberOf(deps: AppDeps, versionId: string | null): number | null {
  if (!versionId) return null;
  const v = deps.db
    .select({ n: novelVersions.versionNumber })
    .from(novelVersions)
    .where(eq(novelVersions.id, versionId))
    .get();
  return v?.n ?? null;
}

function partyOf(deps: AppDeps, n: NovelRow, versionNumber: number | null, viewer: Viewer): AttributionParty {
  const meta = licenseMeta(n.license);
  const available = isPubliclyViewable(n) || canView(n, viewer);
  return {
    novelId: n.id,
    title: n.title,
    author: toAuthorCard(authorOf(deps, n.authorId)),
    license: n.license,
    licenseName: meta.label,
    licenseUrl: meta.url,
    url: isPubliclyViewable(n) ? novelShareUrl(deps.env, n.id) : null,
    versionNumber,
    available,
  };
}

/**
 * 组装一本小说的署名块。`versionNumber` 传当前展示的版本号（没有则 null）。
 */
export function buildAttribution(
  deps: AppDeps,
  novel: NovelRow,
  versionNumber: number | null,
  viewer: Viewer,
): Attribution {
  const work = partyOf(deps, novel, versionNumber ?? versionNumberOf(deps, novel.currentVersionId), viewer);

  // 沿 sourceNovelId 逐跳向上；引用到的是 fork 时锁定的那一版，不是原作的最新版。
  const chain: AttributionParty[] = [];
  let cursorNovelId = novel.sourceNovelId;
  let cursorVersionId = novel.sourceVersionId;
  const seen = new Set<string>([novel.id]);
  while (cursorNovelId && chain.length < MAX_ATTRIBUTION_DEPTH && !seen.has(cursorNovelId)) {
    seen.add(cursorNovelId);
    const row = findNovelRow(deps, cursorNovelId);
    if (!row) break;
    chain.push(partyOf(deps, row, versionNumberOf(deps, cursorVersionId), viewer));
    cursorNovelId = row.sourceNovelId;
    cursorVersionId = row.sourceVersionId;
  }
  // chain 现在是「直接来源 → 更早的来源」，翻转成「根作品 → 直接来源」，读起来更像出处。
  const derivedFrom = chain[0] ?? null;
  chain.reverse();

  const meta = licenseMeta(novel.license);
  return {
    spec: ATTRIBUTION_SPEC,
    work,
    derivedFrom,
    chain,
    requiresAttribution: meta.requiresAttribution,
    nonCommercial: meta.nonCommercial,
    shareAlike: meta.shareAlike,
    allowsDerivatives: meta.allowsDerivatives && novel.allowDerivatives,
    notice: attributionNotice(work, chain),
    generatedAt: iso(deps.clock.now()),
  };
}
