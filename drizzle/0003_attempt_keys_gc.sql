ALTER TABLE `captures` ADD `spz_key` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `gc_pending` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `captures_gc_pending_idx` ON `captures` (`gc_pending`,`updated_at`);