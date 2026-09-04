/**
 * 删除供应商后的级联清理规则。
 *
 * 需要一起收拾的有两处：
 * 1. `settings.defaultProviderId` 里三项用途覆盖（对话 / 写作 / 规划）可能指向已删的 id；
 * 2. `llm_providers.is_default` 那一行被删掉后，没有任何一行是默认的。
 * 这里只算「该怎么改」，落库交给调用方。
 */
import { fmt, t } from '@/i18n';

export type ProviderPurpose = 'chat' | 'writing' | 'planning';

/**
 * 用途的短标签。写成函数而不是模块顶层常量表：`t` 是惰性代理，
 * 但一旦把它读进常量对象里，切语言就更新不了了。
 */
export function purposeLabel(purpose: ProviderPurpose): string {
  const labels: Record<ProviderPurpose, string> = {
    chat: t.settings.purposeChatShort,
    writing: t.settings.purposeWritingShort,
    planning: t.settings.purposePlanningShort,
  };
  return labels[purpose];
}

const PURPOSES: readonly ProviderPurpose[] = ['chat', 'writing', 'planning'];

export type PurposeMap = Record<ProviderPurpose, string | null>;

export interface ProviderCleanupInput {
  /** 被删掉的供应商。 */
  deleted: { id: string; name: string; isDefault: boolean };
  /** 删除之后还剩下的供应商，顺序同 listProviders（默认在前、其次按创建时间）。 */
  remaining: readonly { id: string; name: string }[];
  /** 删除前的用途覆盖。 */
  purposes: PurposeMap;
}

export interface ProviderCleanupPlan {
  /** 需要写回 settings 的新用途覆盖；null 表示三项都没指向被删的供应商。 */
  purposes: PurposeMap | null;
  /** 被重置的用途，用于提示。 */
  clearedPurposes: ProviderPurpose[];
  /** 需要提升为默认的供应商 id；null 表示不用动默认。 */
  promoteDefaultTo: string | null;
  /** 一句给用户看的提示。 */
  notice: string;
}

/** 算出删除某个供应商之后要连带做的事。 */
export function planProviderCleanup(input: ProviderCleanupInput): ProviderCleanupPlan {
  const { deleted, remaining, purposes } = input;
  const cleared = PURPOSES.filter((p) => purposes[p] === deleted.id);
  const nextPurposes: PurposeMap | null = cleared.length === 0
    ? null
    : { ...purposes, ...Object.fromEntries(cleared.map((p) => [p, null])) } as PurposeMap;
  const promoteDefaultTo = deleted.isDefault && remaining.length > 0 ? remaining[0]!.id : null;

  const parts = [fmt(t.settings.cleanupDeleted, { name: deleted.name })];
  if (cleared.length > 0) parts.push(fmt(t.settings.cleanupPurposesReset, { purposes: cleared.map(purposeLabel).join('、') }));
  if (promoteDefaultTo) {
    const next = remaining.find((r) => r.id === promoteDefaultTo);
    if (next) parts.push(fmt(t.settings.cleanupDefaultMoved, { name: next.name }));
  }
  if (remaining.length === 0) parts.push(t.settings.cleanupNoneLeft);

  return { purposes: nextPurposes, clearedPurposes: cleared, promoteDefaultTo, notice: parts.join('') };
}
