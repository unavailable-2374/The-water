CREATE TABLE `bookmarks` (
	`user_id` text NOT NULL,
	`novel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `novel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `bookmarks_user_created_idx` ON `bookmarks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `comment_likes` (
	`user_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `comment_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_likes_comment_idx` ON `comment_likes` (`comment_id`);--> statement-breakpoint
CREATE TABLE `handle_history` (
	`handle` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`released_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `handle_history_user_idx` ON `handle_history` (`user_id`,`released_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor_id` text,
	`kind` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`read_at` integer,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_uq` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`user_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `novel_tags` (
	`novel_id` text NOT NULL,
	`slug` text NOT NULL,
	PRIMARY KEY(`novel_id`, `slug`),
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `novel_tags_slug_idx` ON `novel_tags` (`slug`);--> statement-breakpoint
CREATE TABLE `reading_progress` (
	`user_id` text NOT NULL,
	`novel_id` text NOT NULL,
	`chapter_index` integer DEFAULT 1 NOT NULL,
	`percent` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `novel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reading_progress_user_idx` ON `reading_progress` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`slug` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`novel_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_count_idx` ON `tags` (`novel_count`);--> statement-breakpoint
ALTER TABLE `comments` ADD `chapter_index` integer;--> statement-breakpoint
ALTER TABLE `comments` ADD `like_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `edited_at` integer;--> statement-breakpoint
CREATE INDEX `comments_chapter_idx` ON `comments` (`novel_id`,`chapter_index`,`created_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `novel_tags` (`novel_id`, `slug`)
SELECT n.`id`, lower(trim(t.`value`))
FROM `novels` n, json_each(n.`tags`) t
WHERE trim(t.`value`) <> '';--> statement-breakpoint
INSERT OR REPLACE INTO `tags` (`slug`, `label`, `novel_count`, `updated_at`)
SELECT nt.`slug`, nt.`slug`, COUNT(*), CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `novel_tags` nt
JOIN `novels` n ON n.`id` = nt.`novel_id`
WHERE n.`visibility` = 'public' AND n.`moderation_status` = 'ok' AND n.`deleted_at` IS NULL
GROUP BY nt.`slug`;
