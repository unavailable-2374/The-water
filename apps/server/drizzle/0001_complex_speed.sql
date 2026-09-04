CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`novel_id` text NOT NULL,
	`version_id` text,
	`dedupe_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activities_dedupe_uq` ON `activities` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `activities_actor_idx` ON `activities` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activities_created_idx` ON `activities` (`created_at`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `blocks_blocked_idx` ON `blocks` (`blocked_id`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`novel_id` text NOT NULL,
	`author_id` text NOT NULL,
	`parent_id` text,
	`reply_to_id` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comments_novel_idx` ON `comments` (`novel_id`,`parent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_parent_idx` ON `comments` (`parent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`author_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `follows` (
	`follower_id` text NOT NULL,
	`followee_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`follower_id`, `followee_id`),
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`followee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `follows_followee_idx` ON `follows` (`followee_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `follows_follower_idx` ON `follows` (`follower_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `point_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`points` integer NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`meta` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `point_ledger_dedupe_uq` ON `point_ledger` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `point_ledger_user_idx` ON `point_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `point_ledger_period_idx` ON `point_ledger` (`created_at`,`user_id`);--> statement-breakpoint
CREATE INDEX `point_ledger_ref_idx` ON `point_ledger` (`ref_type`,`ref_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `user_badges` (
	`user_id` text NOT NULL,
	`badge` text NOT NULL,
	`awarded_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `badge`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `novels` ADD `comment_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `comment_id` text;--> statement-breakpoint
-- handle 为新增非空列：先给默认空串，再按 id 尾部随机位回填，最后才能建唯一索引。
ALTER TABLE `users` ADD `handle` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `users` SET `handle` = 'u_' || lower(substr(replace(`id`,'-',''), 21, 12)) WHERE `handle` = '';--> statement-breakpoint
ALTER TABLE `users` ADD `follower_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `following_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `points` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_handle_uq` ON `users` (`handle`);--> statement-breakpoint
CREATE INDEX `users_points_idx` ON `users` (`points`);