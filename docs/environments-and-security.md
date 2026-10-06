# Environments and security boundaries

## Environment strategy

The platform itself will have separate development, staging, and production deployments, configuration, databases, and credentials. Local development uses loopback endpoints and needs no external integrations. Staging will use non-production integration installations and targets. Production will use dedicated platform credentials and controlled release procedures.

Managed projects independently define their own development, staging, and production environments. A project's environment name does not imply access to the corresponding platform deployment. Project and environment IDs must be included in authorization, queries, jobs, webhook correlation, and audit records to prevent cross-project leakage.

Promoting platform code and deploying a managed project are distinct actions. No production deployment or database migration is part of Milestone 0. Later migrations must be versioned, backed up, and verified before production use.

## Security boundaries

- The frontend receives only authorized operational data. It never receives provider tokens, private keys, database passwords, or signing material.
- The API authenticates users, checks project and environment membership, validates requests, and records privileged attempts. Production operations require explicit authorization and approval according to policy.
- Integration credentials are held outside Git and referenced by opaque IDs. The database stores references and non-secret configuration, not raw private keys.
- Server operations are predefined and parameter constrained. The browser has no arbitrary shell or filesystem interface.
- Webhooks will verify provider signatures where available, use replay protection and idempotency, and never trust browser-supplied status as authoritative.
- Logs and audit metadata are bounded and redacted. Secrets must never be echoed to users, logs, or source control.
- Development, staging, and production identities follow least privilege and use separate credentials. Access to one project does not grant access to another.

Milestone 2 uses local bcrypt password hashes and database-backed opaque sessions. Cookie tokens are HttpOnly and SameSite=Strict; the API checks the current account status and role for every protected request. The initial platform-wide policy permits all three roles to read projects and environments, while only Admin can change them or manage users. The role policy is enforced in the API and is independent of UI controls. Login attempts are rate limited in memory for local development. A shared rate-limit store, project-specific memberships, secret manager, provider permission matrix, and operational approvals remain for later milestones and must be settled before privileged integrations are enabled.
