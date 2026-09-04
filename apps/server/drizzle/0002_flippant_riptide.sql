CREATE TABLE `email_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_tokens_hash_uq` ON `email_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `email_tokens_user_idx` ON `email_tokens` (`user_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_tokens_expires_idx` ON `email_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `moderation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`note` text,
	`meta` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `moderation_events_target_idx` ON `moderation_events` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_events_actor_idx` ON `moderation_events` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_events_created_idx` ON `moderation_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `reports` ADD `dedupe_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `reports` SET `dedupe_key` = `novel_id` || ':' || COALESCE(`comment_id`, '-') || ':' || COALESCE(`reporter_id`, 'legacy:' || `id`);--> statement-breakpoint
DELETE FROM `reports` WHERE `id` NOT IN (SELECT MIN(`id`) FROM `reports` GROUP BY `dedupe_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `reports_dedupe_uq` ON `reports` (`dedupe_key`);--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `suspended_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);--> statement-breakpoint
CREATE INDEX `blobs_uploader_idx` ON `blobs` (`first_uploader_id`);--> statement-breakpoint
CREATE INDEX `blobs_created_idx` ON `blobs` (`created_at`);--> statement-breakpoint
DELETE FROM `forks` WHERE `id` NOT IN (
	SELECT `id` FROM `forks` f
	WHERE `created_at` = (SELECT MIN(`created_at`) FROM `forks` g WHERE g.`user_id` = f.`user_id` AND g.`source_novel_id` = f.`source_novel_id`)
	GROUP BY `user_id`, `source_novel_id`
);--> statement-breakpoint
UPDATE `novels` SET `fork_count` = (SELECT COUNT(*) FROM `forks` WHERE `forks`.`source_novel_id` = `novels`.`id`) WHERE `fork_count` <> (SELECT COUNT(*) FROM `forks` WHERE `forks`.`source_novel_id` = `novels`.`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `forks_user_source_uq` ON `forks` (`user_id`,`source_novel_id`);