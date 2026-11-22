ALTER TABLE `captures` ADD `source_kind` text DEFAULT 'photos' NOT NULL;--> statement-breakpoint
ALTER TABLE `captures` ADD `video_key` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `video_upload_id` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `video_bytes` integer;--> statement-breakpoint
ALTER TABLE `captures` ADD `video_mime` text;--> statement-breakpoint
ALTER TABLE `captures` ADD `video_uploaded` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `captures` ADD `keep_video` integer DEFAULT 0 NOT NULL;