---
name: claw
description: Retired compatibility stub for the old alternate container runner. Do not install or execute it; use Andrea's canonical service and route-aware container runtime.
---

# claw (retired)

The old `claw` terminal helper bypassed Andrea's canonical host policy,
route-specific capability boundary, trusted control view, and release
provenance. It is intentionally inert.

Do not copy or symlink its bundled script, invoke it directly, or use it for
development/testing. The preserved script fails closed so historical caches or
old instructions cannot start an alternate agent runner.

Use only the repository-owned paths:

- normal assistant work through the canonical Andrea service;
- container validation through `npm run check:container-contract`,
  `npm run check:container-canary`, and `npm run check:container-mounts`;
- explicitly classified code/advanced work through Andrea's enforced request
  policies.

Reactivation would require a new threat model, an enforceable route policy,
credential/mount isolation, deterministic and real-container tests, and an
explicit product decision. Do not reinterpret this compatibility stub as an
available feature.
