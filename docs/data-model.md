# Core data model

The platform model is implemented incrementally. Milestone 1 added the `projects` and `environments` MySQL tables; Milestone 2 adds `users` and `sessions` through a second versioned migration. Other entities below remain logical designs for later milestones. IDs are UUIDs. A foreign key requires every environment to belong to a project; a compound unique key allows the same environment name in different projects.

| Entity | Purpose and key relationships |
| --- | --- |
| `users` | Platform identities with normalized unique email, bcrypt password hash, role, status, and login timestamp. Milestone 2 roles are platform-wide; project membership is a later extension. |
| `projects` | Independent managed applications or systems; own all project configuration and history. |
| `project_integrations` | Provider installation/configuration per project; store non-secret metadata and secret reference IDs only. |
| `environments` | Development, staging, or production instances owned by a project; hold policy and target selection. |
| `repositories` | Git source references owned by a project; include provider, repository ID, default branch, and optional frontend/backend paths. |
| `mobile_build_configurations` | Project and environment scoped platform, profile, version strategy, and artifact type. |
| `infrastructure_targets` | Project and environment scoped deployment/monitoring targets and predefined operation mappings. |
| `builds` | Requested and observed build runs; link project, environment, source revision, profile, status, and artifacts. |
| `deployments` | Controlled release attempts; link project, environment, target, commit, requester, approval, status, and rollback source. |
| `deployment_steps` | Ordered execution and verification results for one deployment; allow failure diagnosis without arbitrary command access. |
| `approvals` | Decision requests, decision makers, policy, outcome, expiry, and associated action. |
| `health_checks` | Target-specific checks and observations, including timestamps and bounded status details. |
| `webhook_events` | Provider event identity, verification status, processing state, and deduplication key. |
| `audit_logs` | Actor, project, environment, action, target, timestamp, result, and safe metadata for allowed and denied privileged actions. |
| `sessions` | Hashed opaque session token, user foreign key, creation time, and expiry. The raw token exists only in an HttpOnly browser cookie. |

Future project membership/role assignments will be modeled as a relation between `users` and `projects`. A repository may serve multiple environments, while infrastructure targets and operations are environment specific. Builds and deployments retain exact source revisions so history remains traceable after branches move. Webhook event IDs must be unique per provider and installation. Audit records must not contain secret values.

Project status is `active` or `archived`; environment status is `active` or `disabled`. Archiving preserves project and environment records and blocks environment changes until restoration. Future schema work will define the remaining lifecycle rules, indexes, retention rules, and API contracts. Project deletion must not silently erase audit or deployment history.
