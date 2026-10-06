CREATE TABLE `aws_command_records` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`integration_id` varchar(36) NOT NULL,
	`server_id` varchar(36) NOT NULL,
	`provider` varchar(20) NOT NULL DEFAULT 'aws',
	`action` enum('server_identity','disk_usage','memory_usage') NOT NULL,
	`external_command_id` varchar(80),
	`status` enum('queued','in_progress','succeeded','failed','canceled','timed_out') NOT NULL DEFAULT 'queued',
	`provider_status` varchar(40),
	`requested_by_user_id` varchar(36) NOT NULL,
	`requested_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`completed_at` timestamp(3),
	`exit_code` varchar(12),
	`sanitized_output` varchar(4096),
	`sanitized_error` varchar(4096),
	CONSTRAINT `aws_command_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `aws_commands_project_id_unique` UNIQUE(`project_id`,`id`),
	CONSTRAINT `aws_commands_external_unique` UNIQUE(`external_command_id`)
);
--> statement-breakpoint
CREATE TABLE `aws_servers` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`integration_id` varchar(36) NOT NULL,
	`display_name` varchar(120) NOT NULL,
	`role` varchar(80) NOT NULL,
	`region` varchar(40) NOT NULL,
	`instance_id` varchar(32) NOT NULL,
	`managed_instance_id` varchar(32) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `aws_servers_id` PRIMARY KEY(`id`),
	CONSTRAINT `aws_servers_project_id_unique` UNIQUE(`project_id`,`id`),
	CONSTRAINT `aws_servers_project_instance_unique` UNIQUE(`project_id`,`region`,`instance_id`)
);
--> statement-breakpoint
ALTER TABLE `aws_command_records` ADD CONSTRAINT `aws_commands_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aws_command_records` ADD CONSTRAINT `aws_commands_server_fk` FOREIGN KEY (`project_id`,`server_id`) REFERENCES `aws_servers`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aws_command_records` ADD CONSTRAINT `aws_commands_requester_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aws_servers` ADD CONSTRAINT `aws_servers_project_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aws_servers` ADD CONSTRAINT `aws_servers_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `aws_servers` ADD CONSTRAINT `aws_servers_integration_fk` FOREIGN KEY (`project_id`,`integration_id`) REFERENCES `integrations`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `aws_commands_server_requested_idx` ON `aws_command_records` (`project_id`,`server_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `aws_servers_environment_idx` ON `aws_servers` (`project_id`,`environment_id`);