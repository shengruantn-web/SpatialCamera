CREATE TABLE `shares` (
	`id` text PRIMARY KEY NOT NULL,
	`capture_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`views` integer DEFAULT 0 NOT NULL,
	`allow_download` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`capture_id`) REFERENCES `captures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shares_token_hash_idx` ON `shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `shares_capture_created_idx` ON `shares` (`capture_id`,`created_at`);