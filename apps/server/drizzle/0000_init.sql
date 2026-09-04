CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`char_count` integer NOT NULL,
	`byte_size` integer NOT NULL,
	`first_uploader_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `forks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_novel_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`derivative_novel_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_version_id`) REFERENCES `novel_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `forks_user_idx` ON `forks` (`user_id`);--> statement-breakpoint
CREATE INDEX `forks_source_idx` ON `forks` (`source_novel_id`);--> statement-breakpoint
CREATE TABLE `likes` (
	`user_id` text NOT NULL,
	`novel_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `novel_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `likes_user_created_idx` ON `likes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `novel_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`novel_id` text NOT NULL,
	`version_number` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`base_version_id` text,
	`idempotency_key` text,
	`storyline` text NOT NULL,
	`storyline_hash` text NOT NULL,
	`bible` text,
	`manifest` text NOT NULL,
	`change_note` text,
	`chapter_count` integer DEFAULT 0 NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`committed_at` integer,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `novel_versions_idem_uq` ON `novel_versions` (`novel_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `novel_versions_novel_idx` ON `novel_versions` (`novel_id`,`status`);--> statement-breakpoint
CREATE TABLE `novels` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`language` text DEFAULT 'zh-CN' NOT NULL,
	`writing_status` text DEFAULT 'ongoing' NOT NULL,
	`license` text NOT NULL,
	`allow_derivatives` integer DEFAULT false NOT NULL,
	`visibility` text DEFAULT 'unpublished' NOT NULL,
	`publish_visibility` text DEFAULT 'public' NOT NULL,
	`moderation_status` text DEFAULT 'ok' NOT NULL,
	`moderation_note` text,
	`current_version_id` text,
	`source_novel_id` text,
	`source_version_id` text,
	`root_novel_id` text NOT NULL,
	`depth` integer DEFAULT 0 NOT NULL,
	`fork_id` text,
	`chapter_count` integer DEFAULT 0 NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`view_count` integer DEFAULT 0 NOT NULL,
	`like_count` integer DEFAULT 0 NOT NULL,
	`fork_count` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`last_published_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `novels_author_idx` ON `novels` (`author_id`);--> statement-breakpoint
CREATE INDEX `novels_root_idx` ON `novels` (`root_novel_id`);--> statement-breakpoint
CREATE INDEX `novels_source_idx` ON `novels` (`source_novel_id`);--> statement-breakpoint
CREATE INDEX `novels_browse_latest_idx` ON `novels` (`visibility`,`moderation_status`,`last_published_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`novel_id` text NOT NULL,
	`reporter_id` text,
	`reason` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'open' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`client_label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_uq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`bio` text,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uq` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `version_chapters` (
	`version_id` text NOT NULL,
	`index` integer NOT NULL,
	`title` text NOT NULL,
	`blob_hash` text NOT NULL,
	`char_count` integer NOT NULL,
	PRIMARY KEY(`version_id`, `index`),
	FOREIGN KEY (`version_id`) REFERENCES `novel_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `view_events` (
	`novel_id` text NOT NULL,
	`viewer_key` text NOT NULL,
	`day` text NOT NULL,
	PRIMARY KEY(`novel_id`, `viewer_key`, `day`),
	FOREIGN KEY (`novel_id`) REFERENCES `novels`(`id`) ON UPDATE no action ON DELETE cascade
);
