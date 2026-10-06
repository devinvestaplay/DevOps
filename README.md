# Investaplay DevOps Management Platform

An independent platform foundation for managing multiple projects and environments. No managed project or external integration is connected in Milestone 0.

## Workspace

| Path | Purpose |
| --- | --- |
| `apps/web` | Next.js and TypeScript user interface |
| `apps/api` | Node.js, Express, and TypeScript API |
| `packages/contracts` | Shared platform types |
| `docs` | Architecture, data model, security, and environment decisions |

The existing `quiz_final` and `QuizzyFOx` directories are unrelated to this repository and are ignored by its root `.gitignore`.

## Local development

Requirements: Node.js 20.9 or newer, npm, and a local MySQL 8.4 instance. Use a dedicated database named `investaplay_devops_dev` and a user with permissions only on that database. The API and migration tooling reject non-loopback database hosts and other database names during Milestone 1.

On this machine, an official MySQL ZIP installation and its data directory are in ignored `.local/`. Start it with `./scripts/start-local-mysql.ps1`. The local database connection is stored in ignored `apps/api/.env`; `.env.example` shows the required format without a real password. Other workstations can run a separate local MySQL instance on port 3307 and create their own local `.env`.

```sh
npm ci
npm run db:migrate --workspace @investaplay/devops-api
npm run dev:web
npm run dev:api
```

Run the web and API commands in separate terminals. The web app is at `http://127.0.0.1:3000`; the API health endpoint is at `http://127.0.0.1:4001/health`. No cloud credentials are needed.

```sh
npm run typecheck
npm run build
npm run test --workspace @investaplay/devops-api
```

Projects are at `/projects`, with a detail page at `/projects/{projectId}`. The API serves project CRUD and nested environment routes under `/api/projects`. Project `DELETE` archives rather than deleting; archived projects remain readable and can be restored with `PATCH {"status":"active"}`. Environment changes are blocked while a project is archived. The development migration is in `apps/api/drizzle/` and is applied only by the explicit migration command above.

Milestone 2 adds local authentication and role-based authorization. The API and web server still bind to loopback for local development; do not expose either service to a network before deployment security is designed and verified.

Milestone 3 added project and environment scoped integration metadata for GitHub, Expo/EAS, and AWS. The project detail page links to `/projects/{projectId}/integrations`. Admins can configure non-secret provider fields and secret-reference locators there; Developers and Release Managers can view non-sensitive integration status. Configured does not mean a provider connection has been tested. See [docs/integrations-and-secret-references.md](docs/integrations-and-secret-references.md).

Milestone 4 adds an optional read-only GitHub App integration. Follow [docs/github-app-setup.md](docs/github-app-setup.md) for user-controlled GitHub App registration, least-privilege permissions, local key placement, and live connection verification. The platform does not ship an app ID, installation ID, repository, or private key.

Milestone 5 adds project-scoped Expo/EAS connection checks, read-only build visibility, and a guarded Android Preview APK action. See [docs/expo-eas-integration.md](docs/expo-eas-integration.md) for token references, source-root setup, read endpoints, and the production-build boundary. A real Expo connection and Preview APK acceptance build still require user-side setup and explicit confirmation.

Milestone 6 adds mapped EC2 visibility and controlled SSM diagnostics. See [docs/aws-ssm-integration.md](docs/aws-ssm-integration.md) for AWS profile/role setup, least-privilege IAM, server mapping, safe actions, and the real-connectivity checkpoint.

Milestone 7 adds project-scoped controlled server deployment configuration, read-only preflight, exact-revision execution, history, and manual rollback. See [docs/controlled-deployments.md](docs/controlled-deployments.md). Production deployment requires a separate explicit approval after the real preflight; no production deployment is triggered by setup or verification.

## Initial administrator

The users table starts empty. To create the first local administrator, set `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` in the local process environment, then run `npm run create-admin --workspace @investaplay/devops-api`. The password must have at least 12 characters and fit within bcrypt's 72-byte input limit. The command works only when the users table is empty and refuses `NODE_ENV=production`. No default account or password is shipped. Do not put these values in source files or shell history.

The login page is `/login`. Sessions use an HttpOnly, SameSite=Strict cookie and are stored as token hashes in MySQL. Developers and Release Managers may read projects and environments; only Admins may change them or manage users. The API remains the authority for these permissions.

Architecture and future implementation boundaries are described in [docs/architecture.md](docs/architecture.md), [docs/data-model.md](docs/data-model.md), [docs/environments-and-security.md](docs/environments-and-security.md), and [docs/auth-and-rbac.md](docs/auth-and-rbac.md).
