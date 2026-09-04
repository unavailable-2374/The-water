-- 回收站：小说与文档改为软删除，保留 30 天后由启动时的清理任务硬删。
ALTER TABLE novels ADD COLUMN deleted_at INTEGER;
ALTER TABLE documents ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_novels_deleted_at ON novels(deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at);
