# AWS / SSM integration (Milestone 6)

This milestone provides mapped EC2 visibility and three controlled read-only Linux diagnostics. It does not deploy, restart services, edit files, or provide a remote shell.

## Authentication and scope

The API uses the AWS SDK for JavaScript v3 default credential provider chain. Local development can use an `AWS_PROFILE` whose credentials are stored outside this repository, or temporary credentials supplied to the API process by the standard AWS environment variables. No AWS credential is entered into the browser, saved in an integration, or returned by the API. Production should use an IAM role or workload identity with temporary credentials.

An Admin creates an AWS integration for one project and optionally one environment, entering the 12-digit account ID, region, and `ssm` control strategy. An Admin then maps each EC2 instance under that project's **Servers** page to an environment and integration. A mapping holds a display name, role, region, EC2 instance ID, and SSM managed instance ID (the same EC2 ID for ordinary EC2 managed nodes). Multiple servers and environments are supported. Reads are limited to mapped instances; there is no account-wide inventory endpoint. Project IDs and server IDs are checked on every operation.

The **Test connection** button calls STS `GetCallerIdentity` through the AWS global STS endpoint (`aws-global`) and checks the configured account. This is an identity check independent of the integration region; EC2 and SSM calls still use the configured region. If at least one enabled server is mapped to the integration, it also describes one EC2 instance and its SSM managed-node state. The Servers page displays the EC2 state and SSM ping state separately. `EC2 running` does not mean `SSM Online`.

## Minimal operator policy

Replace the placeholders with the actual account, region, and explicitly selected instance IDs. Attach this policy to the API's role or local development profile, never to an EC2 instance merely because it is the target. The example scopes `SendCommand` to one AWS-managed document and selected EC2 instances. EC2 DescribeInstances and SSM DescribeInstanceInformation require account-wide `Resource: "*"` in IAM; the application still queries only mapped instance IDs. `GetCommandInvocation` is used to poll command results. AWS `GetCallerIdentity` works without an explicit Allow, but it is listed for clarity. Confirm any organization-specific SCP or permission boundary separately.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Identity", "Effect": "Allow", "Action": "sts:GetCallerIdentity", "Resource": "*" },
    { "Sid": "MappedRead", "Effect": "Allow", "Action": ["ec2:DescribeInstances", "ssm:DescribeInstanceInformation", "ssm:GetCommandInvocation"], "Resource": "*" },
    { "Sid": "DiagnosticDocument", "Effect": "Allow", "Action": "ssm:SendCommand", "Resource": "arn:aws:ssm:REGION::document/AWS-RunShellScript" },
    { "Sid": "DiagnosticTargets", "Effect": "Allow", "Action": "ssm:SendCommand", "Resource": ["arn:aws:ec2:REGION:ACCOUNT_ID:instance/INSTANCE_ID"] }
  ]
}
```

This policy grants SendCommand at AWS level. The platform's strict three-action allowlist is an application control, so protect the IAM principal from unrelated use. For tighter IAM enforcement, a dedicated custom SSM document and policy would be needed in a later security milestone. The API does not use `ssm:ListCommandInvocations`, `ssm:GetParameter`, SSH, or EC2 mutation APIs.

AWS references: [Run Command IAM setup](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command-setting-up.html), [EC2 instance profile setup](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-instance-permissions.html), [SSM Agent connectivity](https://docs.aws.amazon.com/systems-manager/latest/userguide/troubleshooting-ssm-agent.html).

## Target prerequisites and local setup

The target EC2 instance must be in the selected account and region, running Linux and SSM Agent, authorized to communicate with Systems Manager through an instance profile or the AWS default host management configuration, and able to reach the SSM and `ssmmessages` endpoints (and `ec2messages` where required) over outbound HTTPS. The platform does not install SSM Agent or change an instance profile. An Admin should first verify the target in AWS Systems Manager **Fleet Manager / Managed nodes** and confirm **Online**. If absent or offline, correct agent, IAM, and network setup on the AWS side before testing diagnostics.

For a local named profile, set `AWS_PROFILE` in the **API process environment** before `npm run dev:api`; keep the actual profile credentials under the user's AWS configuration outside this repository. For temporary SDK environment credentials, supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, when present, `AWS_SESSION_TOKEN` to the API process through a trusted local secret mechanism. Do not put values into this document, a Git-tracked file, the browser, or integration metadata. `apps/api/.env` is ignored, but the preferred local setup is `AWS_PROFILE` in the launching shell. Do not send credential values to the assistant.

1. Start local MySQL and apply the DevOpsPannel migration: `./scripts/start-local-mysql.ps1` then `npm run db:migrate --workspace @investaplay/devops-api`.
2. In the API terminal set the selected profile: `$env:AWS_PROFILE = 'YOUR_PROFILE_NAME'`; run `npm run dev:api`.
3. In another terminal run `npm run dev:web`.
4. Sign in as Admin. Open the chosen project → **Integrations** → **Add integration** → **AWS**. Select the environment (or all environments), enter the account ID and region, and choose **SSM**.
5. Open **Servers** → **Map an EC2 server**. Select the environment and AWS integration; enter a display name, role, EC2 instance ID, and optional distinct SSM managed ID. The mapping is local metadata only.
6. Return to **Integrations** and click **Test connection** on that AWS integration. The result checks STS/account and a mapped target if present. Then view EC2 and SSM states under **Servers**.
7. A real diagnostic requires a separate explicit approval for a named action, project, environment, and mapped server. Only then should a Release Manager or Admin click one of the three diagnostic buttons and confirm the target in the dialog.

The account, region, instance ID, and current SSM readiness cannot be determined from the local platform configuration alone. They must be verified by the AWS account owner. The integration is generic and contains no built-in QuizzyFox identifiers.

## Actions, command history, and failures

The browser sends only `server_identity`, `disk_usage`, or `memory_usage`. The API maps these to fixed `AWS-RunShellScript` commands: `hostname; uname -s`, `df -hP`, and `free -m`. Linux/SSM Online/running EC2 checks precede submission. Developers can read mapped status and command results; Release Managers and Admins can request diagnostics; only Admins can configure mappings and test connections. All routes require a session. No arbitrary command, instance ID, or region is accepted in an action request.

The API records requesting user, project/environment/server, action, AWS Command ID, timestamps, normalized status (`queued`, `in_progress`, `succeeded`, `failed`, `canceled`, `timed_out`), exit code, and sanitized output. The UI polls at most 24 times, every five seconds. Output is stripped of control characters, capped at 4096 characters per stream, and redacts common token/key patterns. These checks reduce accidental disclosure but cannot guarantee redaction of every unknown secret format. The allowlist never runs `env`, reads `.env` files, or dumps credentials.

AWS SDK errors are mapped to sanitized authentication, access, rate-limit, network, or provider errors. An unavailable `GetCommandInvocation` immediately after submission remains queued because SSM is eventually consistent. Incorrect account, absent/stopped instance, SSM not managed/offline, and non-Linux target block diagnostic execution. Provider errors do not expose SDK exception text to the browser.

## Rollback

Stop the API and web processes. Disable the AWS integration or server mapping in DevOpsPannel to prevent further diagnostics. Revoke the API IAM policy/profile access at the AWS side if needed. Existing command records remain for audit. Do not drop the local migration tables while command history is needed. No infrastructure change is made by disabling the mapping.
