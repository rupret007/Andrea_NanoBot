---
name: use-native-credential-proxy
description: Retired compatibility stub. Andrea already has a fail-closed degraded single-key environment fallback when OneCLI is unavailable; do not merge or install an alternate credential proxy.
---

# Native credential proxy conversion (retired)

Do not merge the historical `skill/native-credential-proxy` branch or replace
Andrea's current credential path. The supported policy is already built in:

- OneCLI Agent Vault is preferred when operator-provisioned and healthy.
- Otherwise Andrea selects exactly one supported runtime credential and
  classifies execution as `degraded_env_fallback`.
- The value enters only through the spawned runtime child environment;
  container arguments contain a bare `-e KEY`.
- Values must never enter chat, command arguments, process listings, mounted
  files, logs, errors, or diagnostics.

This skill must not read or edit `.env`, accept a pasted credential, change
dependencies, merge a branch, restart services, or run a live provider probe.
Use `/setup` for non-secret status guidance and the canonical repository tests
for credential-boundary validation.
