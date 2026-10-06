CREATE TABLE `integrations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36),
	`provider` varchar(40) NOT NULL,
	`display_name` varchar(120) NOT NULL,
	`status` enum('configured','disabled','error') NOT NULL DEFAULT 'configured',
	`configuration` json NOT NULL,
	`secret_reference_id` varchar(36),
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `integrations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `secret_references` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36),
	`provider` varchar(40) NOT NULL,
	`display_name` varchar(120) NOT NULL,
	`purpose` varchar(120) NOT NULL,
	`reference_type` varchar(40) NOT NULL,
	`reference_key` varchar(512) NOT NULL,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `secret_references_id` PRIMARY KEY(`id`),
	CONSTRAINT `secret_refs_project_id_unique` UNIQUE(`project_id`,`id`)
);
--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_project_id_unique` UNIQUE(`project_id`,`id`);--> statement-breakpoint
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_secret_ref_fk` FOREIGN KEY (`project_id`,`secret_reference_id`) REFERENCES `secret_references`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `secret_references` ADD CONSTRAINT `secret_refs_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `secret_references` ADD CONSTRAINT `secret_refs_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `integrations_project_idx` ON `integrations` (`project_id`);--> statement-breakpoint
CREATE INDEX `integrations_environment_idx` ON `integrations` (`project_id`,`environment_id`);--> statement-breakpoint
CREATE INDEX `secret_refs_environment_idx` ON `secret_references` (`project_id`,`environment_id`);