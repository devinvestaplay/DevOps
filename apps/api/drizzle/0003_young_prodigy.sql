ALTER TABLE `integrations` ADD `last_verified_at` timestamp(3);--> statement-breakpoint
ALTER TABLE `integrations` ADD `last_verification_result` enum('connected','error');--> statement-breakpoint
ALTER TABLE `integrations` ADD `last_verification_reason` varchar(80);