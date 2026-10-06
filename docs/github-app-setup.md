# GitHub App setup for Milestone 4

This platform uses a GitHub App installation for read-only repository data. Repository identity belongs to a project; environment-specific branch or release policy belongs to later milestones. No project or repository is preconfigured. **Do not send the private key in chat, commit it, paste it into the web UI, or add it to integration configuration.**

## Create and install the app

1. In the GitHub account or organization that should own the app, open **Settings → Developer settings → GitHub Apps → New GitHub App**. Choose a unique descriptive name (for example, `your-org-devops-readonly`). Enter a homepage URL you control. This integration uses installation authentication only, so user authorization callbacks and a setup URL are not required. Disable webhooks for this milestone; there is no webhook receiver.
2. Under **Repository permissions**, grant **Metadata: Read** (mandatory), **Contents: Read**, **Pull requests: Read**, and **Actions: Read**. Leave all other repository and account permissions unset. Do not grant write permissions or subscribe to events. Contents supports branches and commits; Pull requests supports the PR list; Actions supports workflow-run status.
3. Set installation availability as appropriate for the repositories you manage. Create the app, then install it on the account that owns the target repository. Choose **Only select repositories** and select the exact repository you want this project to read. For more projects, install/authorize the corresponding repositories. Keep the repository selection as narrow as practical.
4. Record the numeric **App ID** shown in the app settings and the numeric **installation ID** for the installation. The installation ID can be seen in the installed-app settings URL or obtained through GitHub's documented installation listing. These IDs are metadata, not private keys.
5. In the app settings, generate a private key and save the downloaded PEM file in a protected location **outside** this repository. Restrict file access to the account running the API. Do not place the PEM in `quiz_final`, `QuizzyFOx`, the DevOpsPannel source tree, or a tracked file.

GitHub's [app registration](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app), [private key](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), [JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), and [installation token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app) guides describe these settings.

## Local server-side key reference

The current resolver permits only a project-level secret reference with:

| Field | Value |
| --- | --- |
| Provider | `github` |
| Purpose | `github_app_private_key` |
| Reference type | `environment_variable` |
| Reference key | `GITHUB_APP_PRIVATE_KEY` or another `GITHUB_APP_*PRIVATE_KEY` variable name |

Load the downloaded PEM into the API process environment from its protected local file. For example, in the **same PowerShell terminal that will start the API**, set `$env:GITHUB_APP_PRIVATE_KEY = Get-Content -Raw -LiteralPath 'C:\path\outside\repository\app.private-key.pem'`, substituting your own protected path, then run `npm run dev:api`. Do not display the variable value or add the PEM content to `.env`, source files, shell history, or browser storage. The application database stores only the variable **name**. The API resolves it solely in the approved GitHub App authentication path and never returns it.

## Configure the platform

1. Sign in as Admin and open the target project's **Integrations** page.
2. Add a secret reference with the fields above. Choose **All environments**.
3. Add a **GitHub** integration for **All environments**. Enter repository owner, repository name, default branch, repository type, App ID, and installation ID. Select the secret reference. No token or key field exists.
4. Click **Test connection**. A successful result records a verification timestamp and sanitized repository identity. A failure records only a short error code. `Configured` without a successful test does **not** mean connected.
5. Open the project's **GitHub** tab to view the repository, recent branches and commits, open pull requests, and workflow runs. Developers and Release Managers can read this view; only Admins can configure and test connections.

The test uses an RS256 GitHub App JWT (issued 60 seconds early, expiring within 10 minutes), verifies the installation and app ID, requests a short-lived token restricted to the configured repository and four read permissions, then verifies the repository identity. Tokens are not persisted or returned. Read endpoints use the same fixed GitHub API host and five allowed paths; page size is capped at 30. Provider errors are mapped to sanitized platform errors. GitHub being unavailable does not stop the API.

GitHub API permission references: [branches](https://docs.github.com/en/rest/branches/branches), [commits](https://docs.github.com/en/rest/commits/commits), [pull requests](https://docs.github.com/en/rest/pulls/pulls), and [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs).

## Live verification checkpoint

Automated tests use generated RSA keys and a mock transport. They prove implementation behavior, not real GitHub connectivity. Milestone 4 also passed a live connection test against a user-configured installation on 2026-09-24, including the project-scoped test endpoint and all five read endpoints. Each new installation still needs its own connection test. Do not create an app or install it automatically as part of this milestone's code changes.
