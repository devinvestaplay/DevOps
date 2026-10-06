# Integration and secret-reference framework (Milestone 3)

Every integration belongs to one project. It can apply to the whole project or to one environment in that project. Its provider is a string in MySQL, so a later provider can be added without changing the database type. The current API accepts `github`, `expo`, and `aws`. Its status is `configured`, `disabled`, or `error`. **Configured does not mean connection verified.** Provider connectivity is a later milestone.

The local migration `0002_colossal_cable.sql` creates `integrations` and `secret_references`. Composite foreign keys ensure an environment and secret reference belong to the integration's project. The API also checks provider and environment compatibility before associating a reference. A project-wide integration may use a project-wide reference; an environment integration may use a project-wide reference or one for the same environment. Reference scope and provider cannot be changed after creation. Projects may be read when archived, but their integrations and references cannot be changed.

## Non-secret configuration contracts

| Provider | Allowed fields |
| --- | --- |
| GitHub | owner, repository, defaultBranch, repositoryType (`frontend`, `backend`, `monorepo`, `other`) |
| Expo/EAS | expoAccount, projectSlug, projectId (UUID), workingDirectory, previewProfile, productionProfile |
| AWS | region, accountId, controlStrategy (`ssm` or `manual`) |

The API accepts only these fields. Recursive inspection rejects keys resembling tokens, passwords, secrets, private keys, credentials, authorization, or access/API keys, independent of case or nesting. Read responses are reconstructed from the allowlisted contract; malformed stored configuration is returned as `null` rather than echoed. Provider extensions require a new strict contract, UI fields, validation, and tests. No provider client or connection check runs in this milestone.

## Secret boundary

Secret references contain a provider, purpose, scope, reference type, and locator. The current locator types are an environment variable **name**, an AWS Secrets Manager ARN, or an SSM parameter **path**. The API validates the locator format. It never accepts or stores a secret value. It never returns the locator after creation; responses contain `hasReferenceKey: true` instead. There is no endpoint to resolve a reference or read arbitrary environment variables. Milestone 4 adds a backend-only resolver for the exact `github_app_private_key` purpose; other reference types still have no resolver. Resolution must remain inside privileged provider adapters, with no value in browser responses, logs, or audit metadata.

The browser forms request only non-secret configuration and locator metadata. The browser does not store infrastructure credentials in localStorage or sessionStorage. Integration records hold a reference ID, not a raw credential. Do not put private keys in Git or normal configuration JSON. Security events record only action, actor ID, target ID, result, and timestamp.

## API and roles

All paths are under `/api/projects/:projectId` and require an authenticated session.

| Resource | Read | Create/change | Disable |
| --- | --- | --- | --- |
| `/integrations` and `/integrations/:integrationId` | Developer, Release Manager, Admin | Admin | Admin (`DELETE` sets `disabled`) |
| `/secret-references` and `/secret-references/:secretReferenceId` | Admin | Admin | No destructive endpoint |

The API checks nested IDs against the route's project ID and returns 404 for an unrelated record. Unauthorized requests receive 401 or 403. The web integration page shows provider status, an admin configuration form, and an admin secret-reference metadata form. It labels configurations as untested; no external provider is contacted.
