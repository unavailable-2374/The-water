CREATE TABLE `cache_entries` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cache_entries_expires_idx` ON `cache_entries` (`expires_at`);--> statement-breakpoint
CREATE TABLE `novels_fts_pending` (
	`novel_id` text PRIMARY KEY NOT NULL,
	`queued_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `novels_fts_pending_queued_idx` ON `novels_fts_pending` (`queued_at`);--> statement-breakpoint
CREATE TABLE `rate_limit_counters` (
	`bucket` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_ms` integer NOT NULL,
	PRIMARY KEY(`bucket`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limit_counters_window_idx` ON `rate_limit_counters` (`window_start`);--> statement-breakpoint
-- 以下为手写部分：FTS 重建队列的触发器与回填。
-- `novels_fts` 虚拟表本身不在这里建：老的 SQLite 构建可能没编 FTS5，
-- 在迁移里 CREATE VIRTUAL TABLE 会让整次迁移失败。它由 `ensureFtsSchema()` 在迁移之后
-- 用 try/catch 建，失败就把检索降级回 LIKE（见 src/db/fts.ts）。
-- 触发器只碰普通表，任何构建上都能跑。
CREATE TRIGGER IF NOT EXISTS `novels_fts_ai` AFTER INSERT ON `novels` BEGIN
	INSERT INTO `novels_fts_pending` (`novel_id`, `queued_at`)
	VALUES (new.`id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
	ON CONFLICT(`novel_id`) DO UPDATE SET `queued_at` = excluded.`queued_at`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `novels_fts_au` AFTER UPDATE OF `title`, `summary` ON `novels` BEGIN
	INSERT INTO `novels_fts_pending` (`novel_id`, `queued_at`)
	VALUES (new.`id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
	ON CONFLICT(`novel_id`) DO UPDATE SET `queued_at` = excluded.`queued_at`;
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `novels_fts_ad` AFTER DELETE ON `novels` BEGIN
	INSERT INTO `novels_fts_pending` (`novel_id`, `queued_at`)
	VALUES (old.`id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
	ON CONFLICT(`novel_id`) DO UPDATE SET `queued_at` = excluded.`queued_at`;
END;--> statement-breakpoint
-- 已有数据回填：老库里的作品全部排队等待建索引（空库上是 0 行，无副作用）。
INSERT OR IGNORE INTO `novels_fts_pending` (`novel_id`, `queued_at`)
SELECT `id`, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM `novels`;
