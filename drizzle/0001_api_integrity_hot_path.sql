ALTER TABLE `captures` ADD `uploaded_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `captures` ADD `result_key` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `queued_at` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `aligning_at` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `training_at` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `exporting_at` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `ready_at` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `failed_at` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `alignment_ratio` real;--> statement-breakpoint
CREATE INDEX `captures_owner_created_idx` ON `captures` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX `captures_status_created_idx` ON `captures` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `captures_status_updated_idx` ON `captures` (`status`,`updated_at`);--> statement-breakpoint
ALTER TABLE `images` ADD `object_key` text;--> statement-breakpoint
CREATE INDEX `images_capture_uploaded_idx` ON `images` (`capture_id`,`uploaded`);
