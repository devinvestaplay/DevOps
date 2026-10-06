# Platform architecture

## Purpose and ownership

The DevOps platform is an independent application and repository. It does not own the source, deployment host, or credentials of a managed project. Projects are registered later through configuration and scoped integrations. The core platform must work with zero projects and must never assume a particular repository layout, mobile app, cloud account, or process manager.

Each operational resource belongs to a project. Deployment targets, health checks, approvals, and release policy also belong to an environment within that project. A user may have different permissions per project and environment.

## Components

| Component | Responsibility | Milestone 0 state |
| --- | --- | --- |
| Next.js web app | Operator interface; calls the DevOps API | Local login and protected project/environment screens |
| Node.js API | Authentication, authorization, validation, and future orchestration and audit boundary | Local auth, user, project, and environment routes |
| MySQL | Platform configuration and operational history | Local development user, session, project, and environment tables |
| Integration adapters | GitHub, Expo/EAS, and AWS SSM API access | Interfaces planned; no clients |
| Webhook processing | Verify, deduplicate, and process provider events | Planned; no endpoint |
| Operation workers | Execute approved builds and deployments through predefined actions | Planned; none running |

The browser communicates only with the platform API. The API owns privileged credentials and invokes provider adapters or predefined operations. Provider events enter through verified webhooks and update project-scoped records. MySQL will store configuration and history; credentials will be stored in an approved secret manager and referenced by identifier.

## Platform modules

- **Project Management:** registration, membership, environments, and integration configuration.
- **GitHub Integration:** repository metadata, commits, workflows, and verified events.
- **Expo/EAS Integration:** mobile build configuration, requests, and status.
- **AWS/SSM Integration:** narrowly scoped managed-host operations.
- **Build and Deployment Management:** requested actions, lifecycle, steps, artifacts, rollback links.
- **Monitoring and Logs:** bounded health and log views for registered targets.
- **Approvals and Audit:** policy decisions, authorizations, and immutable action records.
- **Settings:** platform and project settings without exposing credential values.

All modules are platform capabilities, not per-project code forks. Provider-specific adapters can be added later without changing the core project/environment model. Milestone 2 adds local authentication, user administration, and role policy. No GitHub, Expo, AWS, or production service integration is connected.
