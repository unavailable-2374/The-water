import { z } from 'zod';
import { AuthorCardSchema, AuthorRefSchema, LICENSE_LABELS, LicenseSchema, WritingStatusSchema, type License } from './novel';
import { StoryBibleSchema, StorylineDocSchema } from './storyline';

// ---- 许可元数据与机器可读署名块（§3.7）----

/**
 * 一种许可的完整描述：人类可读的全文链接 + 机器可读的义务标记。
 * `-nc`（非商业）与 `-sa`（相同方式共享）在这里第一次成为可判定的字段，
 * 之前它们只体现在 license 字符串里，客户端无从提示。
 */
export interface LicenseMeta {
  id: License;
  /** 中文展示名（与 LICENSE_LABELS 一致，冗余一份便于离线渲染）。 */
  label: string;
  /** 许可全文（法律文本）链接；「保留所有权利」没有标准全文，为 null。 */
  url: string | null;
  /** 通俗摘要页；同样可能为 null。 */
  deedUrl: string | null;
  /** SPDX 标识，供导出文件被外部工具识别。 */
  spdx: string | null;
  /** 使用时必须署名原作者。 */
  requiresAttribution: boolean;
  /** 仅限非商业使用。 */
  nonCommercial: boolean;
  /** 衍生作品必须沿用同一许可。 */
  shareAlike: boolean;
  /** 许可本身是否允许改编（与作者的 allowDerivatives 开关是两回事）。 */
  allowsDerivatives: boolean;
}

const CC = 'https://creativecommons.org/licenses';

export const LICENSE_META: Record<License, LicenseMeta> = {
  'all-rights-reserved': {
    id: 'all-rights-reserved',
    label: LICENSE_LABELS['all-rights-reserved'],
    url: null,
    deedUrl: null,
    spdx: null,
    requiresAttribution: true,
    nonCommercial: false,
    shareAlike: false,
    allowsDerivatives: false,
  },
  'cc-by': {
    id: 'cc-by',
    label: LICENSE_LABELS['cc-by'],
    url: `${CC}/by/4.0/legalcode`,
    deedUrl: `${CC}/by/4.0/deed.zh-hans`,
    spdx: 'CC-BY-4.0',
    requiresAttribution: true,
    nonCommercial: false,
    shareAlike: false,
    allowsDerivatives: true,
  },
  'cc-by-sa': {
    id: 'cc-by-sa',
    label: LICENSE_LABELS['cc-by-sa'],
    url: `${CC}/by-sa/4.0/legalcode`,
    deedUrl: `${CC}/by-sa/4.0/deed.zh-hans`,
    spdx: 'CC-BY-SA-4.0',
    requiresAttribution: true,
    nonCommercial: false,
    shareAlike: true,
    allowsDerivatives: true,
  },
  'cc-by-nc': {
    id: 'cc-by-nc',
    label: LICENSE_LABELS['cc-by-nc'],
    url: `${CC}/by-nc/4.0/legalcode`,
    deedUrl: `${CC}/by-nc/4.0/deed.zh-hans`,
    spdx: 'CC-BY-NC-4.0',
    requiresAttribution: true,
    nonCommercial: true,
    shareAlike: false,
    allowsDerivatives: true,
  },
  'cc-by-nc-sa': {
    id: 'cc-by-nc-sa',
    label: LICENSE_LABELS['cc-by-nc-sa'],
    url: `${CC}/by-nc-sa/4.0/legalcode`,
    deedUrl: `${CC}/by-nc-sa/4.0/deed.zh-hans`,
    spdx: 'CC-BY-NC-SA-4.0',
    requiresAttribution: true,
    nonCommercial: true,
    shareAlike: true,
    allowsDerivatives: true,
  },
  cc0: {
    id: 'cc0',
    label: LICENSE_LABELS.cc0,
    url: 'https://creativecommons.org/publicdomain/zero/1.0/legalcode',
    deedUrl: 'https://creativecommons.org/publicdomain/zero/1.0/deed.zh-hans',
    spdx: 'CC0-1.0',
    requiresAttribution: false,
    nonCommercial: false,
    shareAlike: false,
    allowsDerivatives: true,
  },
};

export function licenseMeta(license: License): LicenseMeta {
  return LICENSE_META[license];
}

/** 许可全文链接；作品页的「查看许可全文」按这个取。 */
export function licenseUrl(license: License): string | null {
  return LICENSE_META[license].url;
}

/** 非商业许可的一句话提示；不是 -nc 许可则为 null。 */
export function nonCommercialNotice(license: License): string | null {
  return LICENSE_META[license].nonCommercial
    ? '这个许可只允许非商业使用：转载、改编都可以，但不能用于商业目的。'
    : null;
}

/** 署名块的规格标识，随格式演进递增。 */
export const ATTRIBUTION_SPEC = 'the-water/attribution@1';

/** 署名块里的一方（本作或某一层来源）。 */
export const AttributionPartySchema = z.object({
  novelId: z.string(),
  title: z.string(),
  author: AuthorCardSchema,
  license: LicenseSchema,
  licenseName: z.string(),
  /** 许可全文链接；「保留所有权利」为 null。 */
  licenseUrl: z.string().nullable(),
  /** 该作品的公开地址；服务端未配置 PUBLIC_BASE_URL 或作品已下架时为 null。 */
  url: z.string().nullable(),
  /** 引用到的版本号；本作取当前版本，来源取 fork 时的那一版。 */
  versionNumber: z.number().int().nullable(),
  /** false 表示该作品当前不可公开访问（已下架 / 审核隐藏），署名信息仍需保留。 */
  available: z.boolean(),
});
export type AttributionParty = z.infer<typeof AttributionPartySchema>;

/**
 * 机器可读署名块。bundle 与导出文件都带它，
 * 二创发布前也用它渲染「必须展示的原作署名」。
 */
export const AttributionSchema = z.object({
  spec: z.literal(ATTRIBUTION_SPEC),
  work: AttributionPartySchema,
  /** 直接来源；原创作品为 null。 */
  derivedFrom: AttributionPartySchema.nullable(),
  /** 从根作品到直接来源的完整链条（不含本作）。 */
  chain: z.array(AttributionPartySchema),
  requiresAttribution: z.boolean(),
  nonCommercial: z.boolean(),
  shareAlike: z.boolean(),
  allowsDerivatives: z.boolean(),
  /** 人类可读的中文署名文本，可直接贴进导出文件的扉页。 */
  notice: z.string(),
  generatedAt: z.string(),
});
export type Attribution = z.infer<typeof AttributionSchema>;

function partyLine(p: AttributionParty): string {
  const who = `${p.author.displayName}${p.author.handle ? `（@${p.author.handle}）` : ''}`;
  const ver = p.versionNumber !== null ? ` v${p.versionNumber}` : '';
  const url = p.url ? `　${p.url}` : '';
  return `《${p.title}》${ver} · ${who} · ${p.licenseName}${p.licenseUrl ? `（${p.licenseUrl}）` : ''}${url}`;
}

/**
 * 渲染人类可读的署名文本。服务端写进 bundle，桌面端导出时原样附在文件里，
 * 两边共用这一个实现，避免两处措辞漂移。
 */
export function attributionNotice(work: AttributionParty, chain: AttributionParty[]): string {
  const lines = [`本作：${partyLine(work)}`];
  if (chain.length) {
    lines.push('改编自：');
    for (const p of chain) lines.push(`  · ${partyLine(p)}`);
  }
  const nc = nonCommercialNotice(work.license);
  if (nc) lines.push(nc);
  if (LICENSE_META[work.license].shareAlike) lines.push('这个许可要求：基于本作的改编必须沿用同一许可。');
  return lines.join('\n');
}
export const NovelBundleV1Schema = z.object({
  bundleVersion: z.literal(1),
  exportedAt: z.string(),
  server: z.object({ baseUrl: z.string() }),
  novel: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    language: z.string(),
    writingStatus: WritingStatusSchema,
    license: LicenseSchema,
    allowDerivatives: z.boolean(),
    author: AuthorRefSchema,
  }),
  version: z.object({
    id: z.string(),
    versionNumber: z.number().int(),
    committedAt: z.string().nullable(),
    storylineHash: z.string(),
    chapterCount: z.number().int(),
    charCount: z.number().int(),
  }),
  storyline: StorylineDocSchema,
  bible: StoryBibleSchema.nullable(),
  chapters: z.array(
    z.object({ index: z.number().int(), title: z.string(), hash: z.string(), content: z.string() }),
  ),
  lineage: z.object({
    sourceNovelId: z.string().nullable(),
    sourceVersionId: z.string().nullable(),
    rootNovelId: z.string(),
    depth: z.number().int(),
  }),
  fork: z.object({ id: z.string() }).nullable(),
  /**
   * 机器可读署名块（§3.7）。旧版服务端导出的 bundle 没有这一段，故为可选；
   * 本仓服务端总是写入。
   */
  attribution: AttributionSchema.optional(),
});
export type NovelBundleV1 = z.infer<typeof NovelBundleV1Schema>;

/** fork 后桌面端本地记录的溯源信息。 */
export const NovelOriginSchema = z.object({
  serverUrl: z.string(),
  forkId: z.string(),
  sourceNovelId: z.string(),
  sourceVersionId: z.string(),
  sourceVersionNumber: z.number().int(),
  sourceTitle: z.string(),
  sourceAuthorId: z.string(),
  sourceAuthorDisplayName: z.string(),
  sourceLicense: LicenseSchema,
  rootNovelId: z.string(),
  forkedAt: z.string(),
});
export type NovelOrigin = z.infer<typeof NovelOriginSchema>;
