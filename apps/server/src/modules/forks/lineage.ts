import { eq, isNull, and } from 'drizzle-orm';
import type { LineageNode, LineageResponse, NovelRef } from '@the-water/shared';
import type { AppDeps } from '../../context';
import { novels, novelVersions, users, type NovelRow } from '../../db/schema';
import { toNovelRef, unavailableRef } from '../novels/dto';
import { canView, findNovelRow, loadViewableNovel, type Viewer } from '../novels/service';

export const MAX_ANCESTORS = 64;
export const MAX_DESCENDANTS = 500;

type RowWithAuthor = { n: NovelRow; authorDisplayName: string };

function refOf(r: RowWithAuthor | undefined, id: string, viewer: Viewer): NovelRef {
  if (!r || !canView(r.n, viewer)) return unavailableRef(id);
  return toNovelRef(r.n, { displayName: r.authorDisplayName });
}

/**
 * 祖先：沿 sourceNovelId 逐跳向上（≤64）；后代：一次取出同 rootNovelId 的全部节点（≤500）在内存建树。
 * 不可见节点显示为“（已下架）”占位，但保留结构。
 */
export function buildLineage(deps: AppDeps, novelId: string, viewer: Viewer): LineageResponse {
  const self = loadViewableNovel(deps, novelId, viewer);
  const selfRef = toNovelRef(self, deps.db.select({ displayName: users.displayName }).from(users).where(eq(users.id, self.authorId)).get() ?? { displayName: '' });

  // 祖先（从最近到最远），最后反转为 root → parent 顺序。
  const ancestors: NovelRef[] = [];
  let cur: string | null = self.sourceNovelId;
  const seen = new Set<string>([self.id]);
  while (cur && ancestors.length < MAX_ANCESTORS && !seen.has(cur)) {
    seen.add(cur);
    const row = findNovelRow(deps, cur);
    if (!row) {
      ancestors.push(unavailableRef(cur));
      break;
    }
    const author = deps.db.select({ displayName: users.displayName }).from(users).where(eq(users.id, row.authorId)).get();
    ancestors.push(canView(row, viewer) ? toNovelRef(row, author ?? { displayName: '' }) : unavailableRef(cur));
    cur = row.sourceNovelId;
  }
  ancestors.reverse();

  // 后代：同根全部节点。
  const all = deps.db
    .select({ n: novels, authorDisplayName: users.displayName })
    .from(novels)
    .innerJoin(users, eq(users.id, novels.authorId))
    .where(and(eq(novels.rootNovelId, self.rootNovelId), isNull(novels.deletedAt)))
    .limit(MAX_DESCENDANTS)
    .all();
  const byId = new Map<string, RowWithAuthor>();
  const children = new Map<string, RowWithAuthor[]>();
  for (const r of all) {
    byId.set(r.n.id, r);
    if (r.n.sourceNovelId) {
      const list = children.get(r.n.sourceNovelId) ?? [];
      list.push(r);
      children.set(r.n.sourceNovelId, list);
    }
  }
  const versionNumbers = new Map<string, number>();
  const sourceVersionNumber = (versionId: string | null): number | null => {
    if (!versionId) return null;
    if (versionNumbers.has(versionId)) return versionNumbers.get(versionId)!;
    const v = deps.db.select({ n: novelVersions.versionNumber }).from(novelVersions).where(eq(novelVersions.id, versionId)).get();
    const n = v?.n ?? null;
    if (n !== null) versionNumbers.set(versionId, n);
    return n;
  };
  const visited = new Set<string>();
  const build = (parentId: string, depth: number): LineageNode[] => {
    if (depth > MAX_ANCESTORS) return [];
    const kids = (children.get(parentId) ?? []).sort((a, b) => a.n.createdAt.getTime() - b.n.createdAt.getTime());
    const out: LineageNode[] = [];
    for (const k of kids) {
      if (visited.has(k.n.id)) continue;
      visited.add(k.n.id);
      out.push({
        novel: refOf(k, k.n.id, viewer),
        sourceVersionNumber: sourceVersionNumber(k.n.sourceVersionId),
        children: build(k.n.id, depth + 1),
      });
    }
    return out;
  };
  visited.add(self.id);
  const descendants = build(self.id, 0);

  const root =
    self.rootNovelId === self.id ? selfRef : (ancestors[0] ?? refOf(byId.get(self.rootNovelId), self.rootNovelId, viewer));

  return { root, ancestors, self: selfRef, descendants };
}
