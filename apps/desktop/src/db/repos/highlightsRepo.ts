import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb, now, selectOne } from '../db';
import { parseJson } from '../mappers';

export const AnchorSchema = z.object({
  exact: z.string(),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
  start: z.number().int().nullable().default(null),
  end: z.number().int().nullable().default(null),
  rects: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).default([]),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export type HighlightKind = 'highlight' | 'note';
export interface Highlight {
  id: string; documentId: string; pageNo: number; kind: HighlightKind; color: string; anchor: Anchor;
  noteText: string; createdAt: number; updatedAt: number;
}
interface Raw { id: string; document_id: string; page_no: number; kind: string; color: string; anchor: string; note_text: string; created_at: number; updated_at: number }
const map = (r: Raw): Highlight => ({
  id: r.id, documentId: r.document_id, pageNo: r.page_no, kind: r.kind as HighlightKind, color: r.color,
  anchor: parseJson(AnchorSchema, r.anchor, { exact: '', prefix: '', suffix: '', start: null, end: null, rects: [] }),
  noteText: r.note_text, createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function listHighlights(documentId: string): Promise<Highlight[]> {
  return (await getDb().select<Raw>('SELECT * FROM highlights WHERE document_id = ? ORDER BY page_no, created_at', [documentId])).map(map);
}
export async function createHighlight(input: { documentId: string; pageNo: number; kind: HighlightKind; color?: string; anchor: Anchor; noteText?: string }): Promise<Highlight> {
  const id = nanoid();
  const t = now();
  await getDb().execute(
    'INSERT INTO highlights(id, document_id, page_no, kind, color, anchor, note_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, input.documentId, input.pageNo, input.kind, input.color ?? 'yellow', JSON.stringify(input.anchor), input.noteText ?? '', t, t],
  );
  return (await selectOne<Raw>('SELECT * FROM highlights WHERE id = ?', [id]).then((r) => (r ? map(r) : null)))!;
}
export async function updateHighlight(id: string, patch: { noteText?: string; color?: string; kind?: HighlightKind; anchor?: Anchor }): Promise<void> {
  const cur = await selectOne<Raw>('SELECT * FROM highlights WHERE id = ?', [id]);
  if (!cur) return;
  await getDb().execute('UPDATE highlights SET note_text = ?, color = ?, kind = ?, anchor = ?, updated_at = ? WHERE id = ?', [
    patch.noteText ?? cur.note_text, patch.color ?? cur.color, patch.kind ?? cur.kind,
    patch.anchor ? JSON.stringify(patch.anchor) : cur.anchor, now(), id,
  ]);
}
export async function deleteHighlight(id: string): Promise<void> {
  await getDb().execute('DELETE FROM highlights WHERE id = ?', [id]);
}
