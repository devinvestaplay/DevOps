# Expo/EAS integration (Milestone 5)

Expo is configured per registered DevOps project. A project-level Expo integration identifies an Expo account, project slug, EAS project UUID, source working directory, and separate preview/production profile names. The provider is independent of GitHub; a GitHub integration is optional. An Expo integration can be tested without creating a build. **Configured does not mean connected.**

## Authentication and local setup

The backend runs the pinned official EAS CLI non-interactively with a purpose-specific token reference. [Expo supports `EXPO_TOKEN` for CLI authentication](https://docs.expo.dev/accounts/programmatic-access/). An administrator creates an Expo access token or a Robot user token with access to the chosen Expo project in the Expo dashboard. Do not paste the token into chat, browser forms, source code, or a tracked file.

For local development, load the token into the API process environment as `EXPO_TOKEN`. The platform secret reference must be project-level with provider `expo`, purpose `expo_access_token`, reference type `environment_variable`, and reference key `EXPO_TOKEN` (or another `EXPO_*TOKEN` variable name). The database stores the variable name only. The backend resolves only that purpose and passes the token to the EAS CLI child process. The child receives a reduced environment without the platform database URL. Its raw stdout/stderr is never returned or logged; only allowlisted fields from parsed JSON become API responses. There is no generic environment-variable endpoint.

Set `EXPO_PROJECTS_ROOT` in the API environment to an absolute directory containing approved local Git checkouts. The integration's `workingDirectory` is a relative path inside that root, such as `mobile-app` or `monorepo/apps/mobile`. The server resolves symlinks, rejects paths outside the root, and clones committed source into a temporary directory for each EAS command. For an app with a committed `package-lock.json`, it runs `npm ci --ignore-scripts` in that temporary copy so Expo config plugins can resolve. Dependency installation may make the first connection test take a minute. It cleans up only a verified temporary directory. The managed source checkout is not modified. Uncommitted changes are not included in builds. `EAS_CLI_ENTRYPOINT` is an optional server-side override for the pinned CLI entrypoint; it is intended for controlled testing, not browser input.

The Expo project must already be linked with `extra.eas.projectId` in its app configuration. Expo [documents this requirement for token-based EAS commands](https://docs.expo.dev/accounts/programmatic-access/). The configured account, slug, and EAS project ID must match the `eas config --json` result. A successful `eas build:list --json` verifies read access even if the list is empty. The connection-test endpoint records a timestamp and sanitized status.

## Read endpoints

All endpoints are nested under `/api/projects/:projectId`, require an authenticated session, and require a project-owned `integrationId` in the query or body.

| Endpoint | Result |
| --- | --- |
| `GET /expo/project?integrationId=...` | Sanitized project identity and configured preview profile |
| `GET /expo/builds?integrationId=...&limit=10&offset=0` | Up to 30 sanitized EAS builds plus local panel request records |
| `GET /expo/builds/:buildId?integrationId=...` | One build after checking its EAS project ID |
| `POST /integrations/:integrationId/test` | Admin-only connection test |

Build fields include platform, profile, normalized status, app/build version, Git SHA when available, creation/completion times, artifact **availability**, and a safe error code. Signed artifact URLs, signing credentials, and raw provider error messages are omitted. `build:view` results are checked against the configured EAS project ID, preventing cross-project build ID access. Read and detail requests synchronize matching panel build records.

## Preview APK policy

`POST /expo/builds/preview` accepts only a project-owned Expo `integrationId`. Developer receives 403; Release Manager and Admin may request it. The browser requires a confirmation that names the project and configured profile. The backend chooses Android and the Admin-configured preview profile, with fixed `--non-interactive --json --no-wait --freeze-credentials` options. Browser requests cannot supply a profile, working directory, or CLI flags. No shell is used. The guard parses EAS's JSON5 profile file and checks that the Android effective profile from `eas config --platform android` has `distribution: internal` and `buildType: apk`; the preview profile and its inheritance chain cannot use the production profile. [Expo documents profile configuration](https://docs.expo.dev/build/eas-json/) and [the CLI flags](https://docs.expo.dev/eas/cli/).

The platform records the requester, project, integration, Android profile, source commit/branch when available, external EAS build ID, normalized status, timestamps, artifact availability, and a sanitized error code. It does not store the Expo token or signing credentials. A new request is rejected while a matching panel build is queued or in progress. Status mapping: `NEW`/`IN_QUEUE` → queued; `IN_PROGRESS`/`PENDING_CANCEL` → in progress; `FINISHED` → succeeded; `ERRORED` → failed; `CANCELED` → canceled. Succeeded and artifact available are separate facts. The Builds page refreshes every 30 seconds while open.

**Production AAB generation is not enabled in Milestone 5.** There is no production build endpoint, button, or caller-controlled profile. Future production builds require separate release controls. No app-store submission or signing-key management is implemented.

## Verification boundary

Automated tests use a fake EAS CLI and temporary Git source. They verify role policy, project/build isolation, token redaction, provider failure sanitization, status mapping, and the production guard. Before a real connection test, an administrator must configure the Expo token, approved source root, and non-secret integration metadata. A real Preview APK may be triggered only after that connection succeeds and the user explicitly confirms the resource-consuming action.
