CREATE TABLE `writing_task_events` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event` text NOT NULL,
	PRIMARY KEY(`task_id`, `seq`),
	FOREIGN KEY (`task_id`) REFERENCES `writing_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `writing_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`request` text,
	`binding` text,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`error` text,
	`usage` text,
	`worker_id` text,
	`lease_until` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `writing_tasks_key_uq` ON `writing_tasks` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `writing_tasks_queue_idx` ON `writing_tasks` (`status`,`created_at`);