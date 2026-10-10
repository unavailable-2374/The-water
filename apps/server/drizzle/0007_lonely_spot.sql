CREATE TABLE `writing_memory_sessions` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_key` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`chapter_no` integer NOT NULL,
	`version_key` text NOT NULL,
	`entries` text NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `writing_memory_sessions_expires_idx` ON `writing_memory_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `writing_memory_sessions_scope_idx` ON `writing_memory_sessions` (`session_key`,`chapter_no`);--> statement-breakpoint
ALTER TABLE `writing_tasks` ADD `session_key` text;