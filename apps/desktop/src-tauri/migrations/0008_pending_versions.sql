-- 待采纳版本、版本清理、会话级自动保存（§2.2 第 1、2、3、4 条）。
--
-- 原来 chapter_versions 只有「存在」这一种状态：createVersion 一插就把它置为
-- current，作者既没机会在改写前看一眼旧正文，也没机会在改写后逐章取舍。
-- 这里给版本行补三组列：
--
--   state / baseline_version_id —— 「待采纳」。改写会话开着的时候产出的版本一律
--       落 state='pending'，并记下它替换掉的那一版（baseline_version_id），
--       作者逐章采纳（→ accepted）或丢弃（→ discarded，章节回到 baseline）。
--       版本仍然照旧置为 current：adjust_length / style_check / summarize 都读
--       chapters.current_version_id，不置 current 后面几步就会拿着旧正文干活。
--       「待采纳」是**取舍状态**，不是「未生效状态」。
--   pinned —— 手动钉住，版本清理永远绕开它。
--   session_id / updated_at —— 会话级自动保存。session_id 非空表示这一行还在
--       一次编辑会话里，2 秒空闲只更新这一行；离开章节或 5 分钟无操作才封版
--       （session_id 置回 NULL）。原来每 2 秒空闲建一个新版本，手动改几分钟
--       就是几十稿。
--
-- chapters 上的三列记的是「这一章正开着的改写会话」：改写前的版本与章节状态
-- （撤销这次改写就是回到它们），以及是哪个任务改的。三列同时为空 = 没有待采纳。
--
-- 老数据一律按「已采纳、没钉住、不在会话里」补齐，语义与迁移前一致。

ALTER TABLE chapter_versions ADD COLUMN state TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE chapter_versions ADD COLUMN baseline_version_id TEXT;
ALTER TABLE chapter_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chapter_versions ADD COLUMN session_id TEXT;
ALTER TABLE chapter_versions ADD COLUMN updated_at INTEGER;

UPDATE chapter_versions SET updated_at = created_at WHERE updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cv_state ON chapter_versions(chapter_id, state);
CREATE INDEX IF NOT EXISTS idx_cv_session ON chapter_versions(session_id);

ALTER TABLE chapters ADD COLUMN rewrite_baseline_version_id TEXT;
ALTER TABLE chapters ADD COLUMN rewrite_baseline_status TEXT;
ALTER TABLE chapters ADD COLUMN rewrite_job_id TEXT;

CREATE INDEX IF NOT EXISTS idx_ch_rewrite_pending ON chapters(novel_id, rewrite_baseline_version_id);
