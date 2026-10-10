import { nanoid } from 'nanoid';
import { getDb, now, selectOne } from '../db';
import { bool, num, parseJsonLoose, str } from '../mappers';
import type { JsonMode, ProviderConfig, ProviderKind } from '@/llm/types';
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from '@/llm/config';

interface Row {
  id: string; name: string; kind: string; base_url: string; model: string; context_window: number;
  reasoning_effort: ProviderConfig['reasoningEffort'] | null; reasoning_tokens: number; max_output_tokens: number; json_mode: string; temperature: number; extra_headers: string;
  secret_ref: string; is_default: number; created_at: number; updated_at: number;
  // 0004_provider_runtime.sql
  first_byte_timeout_ms: number; idle_timeout_ms: number; proxy_url: string; concurrency: number;
}

function map(r: Row): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    baseUrl: r.base_url,
    model: r.model,
    contextWindow: num(r.context_window, 128000),
    maxOutputTokens: num(r.max_output_tokens, 8192),
    reasoningTokens: num(r.reasoning_tokens,0),
    reasoningEffort: r.reasoning_effort ?? undefined,
    jsonMode: str(r.json_mode, 'none') as JsonMode,
    temperature: num(r.temperature, 0.8),
    extraHeaders: parseJsonLoose<Record<string, string>>(r.extra_headers, {}),
    secretRef: r.secret_ref,
    firstByteTimeoutMs: num(r.first_byte_timeout_ms, DEFAULT_FIRST_BYTE_TIMEOUT_MS),
    idleTimeoutMs: num(r.idle_timeout_ms, DEFAULT_IDLE_TIMEOUT_MS),
    proxyUrl: str(r.proxy_url, ''),
    concurrency: num(r.concurrency, 1),
    isDefault: bool(r.is_default),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type ProviderInput = Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt' | 'isDefault'> & { isDefault?: boolean };

export async function listProviders(): Promise<ProviderConfig[]> {
  const rows = await getDb().select<Row>('SELECT * FROM llm_providers ORDER BY is_default DESC, created_at ASC');
  return rows.map(map);
}

export async function getProvider(id: string): Promise<ProviderConfig | null> {
  const r = await selectOne<Row>('SELECT * FROM llm_providers WHERE id = ?', [id]);
  return r ? map(r) : null;
}

export async function getDefaultProvider(): Promise<ProviderConfig | null> {
  const r = await selectOne<Row>('SELECT * FROM llm_providers ORDER BY is_default DESC, created_at ASC LIMIT 1');
  return r ? map(r) : null;
}

export async function createProvider(input: ProviderInput, id = nanoid()): Promise<ProviderConfig> {
  validateOutputBudget(input);
  const t = now();
  const db = getDb();
  const count = await selectOne<{ c: number }>('SELECT COUNT(*) AS c FROM llm_providers');
  const isDefault = input.isDefault ?? (count?.c ?? 0) === 0;
  if (isDefault) await db.execute('UPDATE llm_providers SET is_default = 0');
  await db.execute(
    `INSERT INTO llm_providers(id, name, kind, base_url, model, context_window, max_output_tokens, json_mode, temperature, extra_headers, secret_ref, is_default, created_at, updated_at, first_byte_timeout_ms, idle_timeout_ms, proxy_url, concurrency, reasoning_tokens, reasoning_effort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, input.kind, input.baseUrl.replace(/\/+$/, ''), input.model, input.contextWindow, input.maxOutputTokens,
      input.jsonMode, input.temperature, JSON.stringify(input.extraHeaders ?? {}), input.secretRef, isDefault ? 1 : 0, t, t,
      input.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS, input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      input.proxyUrl ?? '', input.concurrency ?? 1, input.reasoningTokens ?? 0, input.reasoningEffort ?? null],
  );
  return (await getProvider(id))!;
}

export async function updateProvider(id: string, patch: Partial<ProviderInput>): Promise<ProviderConfig | null> {
  const cur = await getProvider(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  validateOutputBudget(next);
  const db = getDb();
  if (patch.isDefault) await db.execute('UPDATE llm_providers SET is_default = 0');
  await db.execute(
    `UPDATE llm_providers SET name=?, kind=?, base_url=?, model=?, context_window=?, max_output_tokens=?, json_mode=?, temperature=?, extra_headers=?, secret_ref=?, is_default=?, updated_at=?, first_byte_timeout_ms=?, idle_timeout_ms=?, proxy_url=?, concurrency=?, reasoning_tokens=?, reasoning_effort=? WHERE id=?`,
    [next.name, next.kind, next.baseUrl.replace(/\/+$/, ''), next.model, next.contextWindow, next.maxOutputTokens, next.jsonMode,
      next.temperature, JSON.stringify(next.extraHeaders ?? {}), next.secretRef, patch.isDefault ? 1 : cur.isDefault ? 1 : 0, now(),
      next.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS, next.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      next.proxyUrl ?? '', next.concurrency ?? 1, next.reasoningTokens ?? 0, next.reasoningEffort ?? null, id],
  );
  return getProvider(id);
}

export async function setDefaultProvider(id: string): Promise<void> {
  const db = getDb();
  await db.execute('UPDATE llm_providers SET is_default = 0');
  await db.execute('UPDATE llm_providers SET is_default = 1, updated_at = ? WHERE id = ?', [now(), id]);
}

export async function deleteProvider(id: string): Promise<void> {
  await getDb().execute('DELETE FROM llm_providers WHERE id = ?', [id]);
}

function validateOutputBudget(input:Pick<ProviderConfig,'maxOutputTokens'|'reasoningTokens'>) {
 const reserve=input.reasoningTokens ?? 0;
 if(!Number.isInteger(reserve) || reserve<0 || reserve>=input.maxOutputTokens) throw new Error('推理预留必须是非负整数，且小于最大输出预算');
}
