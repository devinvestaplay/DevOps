# Authentication and role policy (Milestone 2)

This milestone uses local accounts and MySQL-backed opaque sessions. Passwords are hashed with bcrypt at cost 12. The raw session token is sent only as an HttpOnly, SameSite=Strict cookie and its SHA-256 hash is stored in `sessions`. The cookie has a seven-day maximum age and is marked Secure when `NODE_ENV=production`. The API checks session expiry, current user status, and current role on every protected request. Logging out deletes the session; disabling a user deletes their sessions.

The API is the authorization authority. The web UI hides controls users cannot use, and protected project pages verify the session server-side before rendering. Project and environment data remains scoped by project ID. Accounts are platform-wide in this milestone; project-specific memberships are future work.

| Operation | Developer | Release Manager | Admin |
| --- | --- | --- | --- |
| Read projects and environments | Yes | Yes | Yes |
| Create, edit, archive projects | No | No | Yes |
| Create or edit environments | No | No | Yes |
| List, create, read, edit users | No | No | Yes |

`POST /api/auth/login` is rate limited to ten unsuccessful attempts per IP over fifteen minutes in the local API process. Responses do not distinguish unknown accounts, wrong passwords, or disabled accounts. The API validates Origin on mutating browser requests and sends `Cache-Control: no-store` for API responses. Security event records contain actor ID, action, target ID, timestamp, and result, with no password, hash, cookie, or session token.

The initial Admin is created only by the explicit local `create-admin` command documented in the README. It requires a credential supplied at run time and refuses to run if any user already exists or if `NODE_ENV=production`. There is no default account. The local rate-limit store, bootstrap workflow, and platform-wide roles are development foundations; production deployment and project-specific policy require later design and tests.
