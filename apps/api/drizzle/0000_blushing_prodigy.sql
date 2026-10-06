CREATE TABLE `environments` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`type` enum('development','staging','production') NOT NULL,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `environments_id` PRIMARY KEY(`id`),
	CONSTRAINT `environments_project_name_unique` UNIQUE(`project_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`description` varchar(2000) NOT NULL DEFAULT '',
	`status` enum('active','archived') NOT NULL DEFAULT 'active',
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `environments` ADD CONSTRAINT `environments_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);