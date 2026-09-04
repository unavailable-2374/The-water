/** 全部主键为 UUIDv7 文本，时间有序。 */
export function newId(): string {
  return Bun.randomUUIDv7();
}
