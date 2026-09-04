import { nanoid } from 'nanoid';
import { getDb, now, selectOne } from '../db';
import { parseJsonLoose } from '../mappers';
import { recordUsage } from './usageRepo';
import type { ChatRole } from '@/llm/types';

export type ConversationKind = 'pdf_discuss' | 'novel_assist' | 'scratch';
export interface Conversation {
  id: string; kind: ConversationKind; documentId: string | null; novelId: string | null; chapterId: string | null;
  title: string; providerId: string | null; createdAt: number; updatedAt: number;
}
export interface MessageContext {
  selectedText?: string; pageNo?: number; before?: string; after?: string;
}
export interface Message {
  id: string; conversationId: string; seq: number; role: ChatRole; content: string; context: MessageContext | null;
  usage: { inputTokens: number; outputTokens: number } | null; model: string | null; createdAt: number;
}
interface RawC { id: string; kind: string; document_id: string | null; novel_id: string | null; chapter_id: string | null; title: string; provider_id: string | null; created_at: number; updated_at: number }
interface RawM { id: string; conversation_id: string; seq: number; role: string; content: string; context: string | null; usage: string | null; model: string | null; created_at: number }
const mapC = (r: RawC): Conversation => ({
  id: r.id, kind: r.kind as ConversationKind, documentId: r.document_id, novelId: r.novel_id, chapterId: r.chapter_id,
  title: r.title, providerId: r.provider_id, createdAt: r.created_at, updatedAt: r.updated_at,
});
const mapM = (r: RawM): Message => ({
  id: r.id, conversationId: r.conversation_id, seq: r.seq, role: r.role as ChatRole, content: r.content,
  context: parseJsonLoose<MessageContext | null>(r.context, null), usage: parseJsonLoose(r.usage, null), model: r.model, createdAt: r.created_at,
});

export async function listConversations(filter: { documentId?: string; novelId?: string; kind?: ConversationKind }): Promise<Conversation[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.documentId) { where.push('document_id = ?'); params.push(filter.documentId); }
  if (filter.novelId) { where.push('novel_id = ?'); params.push(filter.novelId); }
  if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
  const sql = `SELECT * FROM ai_conversations ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
  return (await getDb().select<RawC>(sql, params)).map(mapC);
}
export async function getConversation(id: string): Promise<Conversation | null> {
  const r = await selectOne<RawC>('SELECT * FROM ai_conversations WHERE id = ?', [id]);
  return r ? mapC(r) : null;
}
export async function createConversation(input: { kind: ConversationKind; documentId?: string | null; novelId?: string | null; chapterId?: string | null; title?: string; providerId?: string | null }): Promise<Conversation> {
  const id = nanoid();
  const t = now();
  await getDb().execute(
    'INSERT INTO ai_conversations(id, kind, document_id, novel_id, chapter_id, title, provider_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, input.kind, input.documentId ?? null, input.novelId ?? null, input.chapterId ?? null, input.title ?? '新对话', input.providerId ?? null, t, t],
  );
  return (await getConversation(id))!;
}
export async function renameConversation(id: string, title: string): Promise<void> {
  await getDb().execute('UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?', [title, now(), id]);
}
export async function deleteConversation(id: string): Promise<void> {
  await getDb().execute('DELETE FROM ai_conversations WHERE id = ?', [id]);
}
export async function listMessages(conversationId: string): Promise<Message[]> {
  return (await getDb().select<RawM>('SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY seq', [conversationId])).map(mapM);
}
export async function appendMessage(input: { conversationId: string; role: ChatRole; content: string; context?: MessageContext | null; usage?: Message['usage']; model?: string | null }): Promise<Message> {
  const db = getDb();
  const last = await selectOne<{ m: number | null }>('SELECT MAX(seq) AS m FROM ai_messages WHERE conversation_id = ?', [input.conversationId]);
  const seq = (last?.m ?? 0) + 1;
  const id = nanoid();
  await db.execute(
    'INSERT INTO ai_messages(id, conversation_id, seq, role, content, context, usage, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, input.conversationId, seq, input.role, input.content, input.context ? JSON.stringify(input.context) : null,
      input.usage ? JSON.stringify(input.usage) : null, input.model ?? null, now()],
  );
  await db.execute('UPDATE ai_conversations SET updated_at = ? WHERE id = ?', [now(), input.conversationId]);
  // 聊天的 token 用量以前只存在 ai_messages.usage 里、从没被聚合过（§2.1 第 3 条）。
  // 在这里顺手记一条用量事件，「本月花了多少钱」才算得上完整。
  if (input.usage) {
    const conv = await getConversation(input.conversationId);
    await recordUsage({
      usage: input.usage, purpose: 'chat', model: input.model ?? '',
      conversationId: input.conversationId, novelId: conv?.novelId ?? null,
    }).catch((e) => console.error('记录聊天用量失败', e));
  }
  return (await selectOne<RawM>('SELECT * FROM ai_messages WHERE id = ?', [id]).then((r) => (r ? mapM(r) : null)))!;
}
export async function updateMessageContent(id: string, content: string, usage?: Message['usage'], model?: string | null): Promise<void> {
  await getDb().execute('UPDATE ai_messages SET content = ?, usage = COALESCE(?, usage), model = COALESCE(?, model) WHERE id = ?', [
    content, usage ? JSON.stringify(usage) : null, model ?? null, id,
  ]);
}
export async function deleteMessage(id: string): Promise<void> {
  await getDb().execute('DELETE FROM ai_messages WHERE id = ?', [id]);
}
