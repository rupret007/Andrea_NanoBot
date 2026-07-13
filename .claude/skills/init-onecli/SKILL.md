---
name: init-onecli
description: Preflight an existing OneCLI Agent Vault and explain the operator decision. This skill never installs OneCLI, migrates credentials, reads secret values, or changes credential state.
---

# OneCLI Agent Vault preflight

OneCLI is Andrea's preferred credential boundary, but installation and
credential migration are explicit operator decisions. This preserved skill is
preflight-only for the current release.

## Safe checks

Run only non-mutating checks:

```bash
onecli version 2>/dev/null
curl -sf -o /dev/null http://127.0.0.1:10254/api/health
```

If both succeed, `onecli secrets list` may be used to inspect bounded secret
names/types/status only. Never request, print, log, or return a secret value.

If OneCLI is missing or unhealthy, stop and report:

- OneCLI-backed execution is unavailable;
- Andrea can continue in the explicitly degraded single-key environment mode;
- installation/provisioning remains a future operator action outside this
  assistant session.

## Prohibited actions

This skill must not:

- download or execute an installer;
- modify shell profiles or OneCLI configuration;
- read or display `.env` contents;
- accept credentials pasted in chat;
- place a value in command arguments, shell history, logs, or diagnostics;
- migrate, delete, rewrite, or rotate any credential;
- restart services or perform a paid/live provider request.

When the operator later provisions OneCLI through a trusted external surface,
rerun the safe checks above and then use repository status/tests to classify the
credential mode. Do not claim vault-backed isolation until that evidence is
present.
