CREATE TABLE `deployment_configurations` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`server_id` varchar(36) NOT NULL,
	`github_integration_id` varchar(36) NOT NULL,
	`allowed_branch` varchar(120) NOT NULL,
	`repository_path` varchar(240) NOT NULL,
	`application_path` varchar(240) NOT NULL,
	`package_manager` enum('none','npm') NOT NULL,
	`install_strategy` enum('none','npm_ci') NOT NULL,
	`build_strategy` enum('none','npm_build') NOT NULL,
	`process_manager` enum('pm2') NOT NULL,
	`service_name` varchar(100) NOT NULL,
	`health_url` varchar(512) NOT NULL,
	`health_timeout_seconds` int NOT NULL,
	`rollback_strategy` enum('manual') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`created_at` timestamp(3) NOT NULL DEFAULT (now()),
	`updated_at` timestamp(3) NOT NULL DEFAULT (now()),
	CONSTRAINT `deployment_configurations_id` PRIMARY KEY(`id`),
	CONSTRAINT `deploy_config_project_id_unique` UNIQUE(`project_id`,`id`),
	CONSTRAINT `deploy_config_target_unique` UNIQUE(`project_id`,`environment_id`,`server_id`)
);
--> statement-breakpoint
CREATE TABLE `deployment_records` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`environment_id` varchar(36) NOT NULL,
	`server_id` varchar(36) NOT NULL,
	`configuration_id` varchar(36) NOT NULL,
	`github_integration_id` varchar(36) NOT NULL,
	`repository_owner` varchar(200) NOT NULL,
	`repository_name` varchar(200) NOT NULL,
	`requested_ref` varchar(120) NOT NULL,
	`target_sha` varchar(40) NOT NULL,
	`previous_sha` varchar(40),
	`status` enum('awaiting_confirmation','queued','in_progress','verifying','succeeded','failed','rollback_pending','rolling_back','rolled_back','rollback_failed','canceled') NOT NULL DEFAULT 'awaiting_confirmation',
	`active_target_key` varchar(120),
	`configuration_snapshot` json NOT NULL,
	`preflighted_at` timestamp(3) NOT NULL,
	`requested_by_user_id` varchar(36) NOT NULL,
	`requested_at` timestamp(3) NOT NULL DEFAULT (now()),
	`started_at` timestamp(3),
	`completed_at` timestamp(3),
	`health_http_status` int,
	`health_latency_ms` int,
	`health_checked_at` timestamp(3),
	`health_response` varchar(2048),
	`sanitized_error` varchar(4096),
	CONSTRAINT `deployment_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `deploy_records_project_id_unique` UNIQUE(`project_id`,`id`),
	CONSTRAINT `deploy_records_active_target_unique` UNIQUE(`active_target_key`)
);
--> statement-breakpoint
CREATE TABLE `deployment_step_records` (
	`id` varchar(36) NOT NULL,
	`project_id` varchar(36) NOT NULL,
	`deployment_id` varchar(36) NOT NULL,
	`sequence` int NOT NULL,
	`step_type` enum('preflight','capture_current_revision','fetch_source','checkout_revision','install_dependencies','build','restart_service','health_check','rollback_checkout','rollback_restart','rollback_health_check') NOT NULL,
	`status` enum('pending','in_progress','succeeded','failed','skipped','timed_out') NOT NULL DEFAULT 'pending',
	`started_at` timestamp(3),
	`completed_at` timestamp(3),
	`external_command_id` varchar(80),
	`exit_code` int,
	`sanitized_output` varchar(4096),
	`sanitized_error` varchar(4096),
	CONSTRAINT `deployment_step_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `deploy_steps_order_unique` UNIQUE(`deployment_id`,`sequence`)
);
--> statement-breakpoint
ALTER TABLE `deployment_configurations` ADD CONSTRAINT `deploy_config_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_configurations` ADD CONSTRAINT `deploy_config_server_fk` FOREIGN KEY (`project_id`,`server_id`) REFERENCES `aws_servers`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_configurations` ADD CONSTRAINT `deploy_config_github_fk` FOREIGN KEY (`project_id`,`github_integration_id`) REFERENCES `integrations`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_records` ADD CONSTRAINT `deploy_records_config_fk` FOREIGN KEY (`project_id`,`configuration_id`) REFERENCES `deployment_configurations`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_records` ADD CONSTRAINT `deploy_records_environment_fk` FOREIGN KEY (`project_id`,`environment_id`) REFERENCES `environments`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_records` ADD CONSTRAINT `deploy_records_server_fk` FOREIGN KEY (`project_id`,`server_id`) REFERENCES `aws_servers`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_records` ADD CONSTRAINT `deploy_records_requester_fk` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deployment_step_records` ADD CONSTRAINT `deploy_steps_deployment_fk` FOREIGN KEY (`project_id`,`deployment_id`) REFERENCES `deployment_records`(`project_id`,`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `deploy_records_project_requested_idx` ON `deployment_records` (`project_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `deploy_steps_project_deployment_idx` ON `deployment_step_records` (`project_id`,`deployment_id`);