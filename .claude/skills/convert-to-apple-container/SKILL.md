---
name: convert-to-apple-container
description: Retired compatibility stub. Andrea agent execution on Apple Container is fail-closed until that runtime passes the same nested read-only mount canary as Docker and Podman.
---

# Convert to Apple Container (retired)

Do not convert this repository to Apple Container or merge the historical
`skill/apple-container` branch. Those instructions predate Andrea's immutable
runner and trusted-control overlays and can weaken the current container trust
boundary.

Current release truth:

- Docker and Podman are the supported agent-execution runtimes.
- Apple Container may be detected for diagnostics, but execution fails closed.
- Availability, networking, or a basic read-only mount is not sufficient proof;
  the runtime must pass the repository's isolated nested-mount and restart-
  continuity canary before it can be promoted.
- Do not apply privileged networking changes, replace the runtime abstraction,
  start containers as root, or weaken mount/credential policy to make it work.

Use `/setup` with Docker or Podman. Preserve this stub only so older references
lead to the safe boundary instead of executing obsolete migration steps.
