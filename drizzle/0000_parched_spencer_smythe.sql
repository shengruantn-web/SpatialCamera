CREATE TABLE `captures` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`image_count` integer NOT NULL,
	`error` text,
	`lease` text,
	`result_bytes` integer
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`name` text NOT NULL,
	`bytes` integer NOT NULL,
	`mime` text NOT NULL,
	`uploaded` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_health` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL
);
