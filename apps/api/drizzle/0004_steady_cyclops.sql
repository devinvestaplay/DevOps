CREATE TABLE `build_records` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`integration_id` varchar(36) NOT NULL,
	`environment_id` varchar(36),
	`provider` varchar(40) NOT NULL,
	`external_build_id` varchar(80),
	`platform` enum('android') NOT NULL,
	`profile` varchar(200) NOT NULL,
	`status` enum('queued','in_progress','succeeded','failed','canceled') NOT NULL DEFAULT 'queued',
	`provider_status` varchar(40),
	`app_version` varchar(80),
	`app_build_version` varchar(80),
	`git_commit_sha` varchar(64),
	`git_branch` varchar(200),
	`requested_by_user_id` varchar(36),
	`requested_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`completed_at` timestamp(3),
	`artifact_available` boolean NOT NULL DEFAULT false,
	`error_code` varchar(80),
	CONSTRAINT `build_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `build_records_provider_external_unique` UNIQUE(`provider`,`external_build_id`)
);
--> statement-breakpoint
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_project_id_unique` UNIQUE(`project_id`,`id`);--> statement-breakpoint
ALTER TABLE `build_records` ADD CONSTRAINT `build_records_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `build_records` ADD CONSTRAINT `build_records_integration_fk` FOREIGN KEY (`project_id`,`integration_id`) REFERENCES `integrations`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `build_records` ADD CONSTRAINT `build_records_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `build_records` ADD CONSTRAINT `build_records_requester_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `build_records_project_requested_idx` ON `build_records` (`project_id`,`requested_at`);