# Docker Sandbox Status

The old manual Docker Sandbox patch guide is intentionally retired. It described
an upstream NanoClaw checkout and asked operators to weaken TLS, copy
credentials/configuration into writable paths, patch source files by hand, and
use `npm install`. Those instructions do not describe Andrea's current security
or release contract and must not be applied to this repository.

## Supported container path

Andrea's supported agent container is the repository-owned image built from
`container/Dockerfile`:

- Node is pinned to `22.22.2` in the image.
- dependencies are installed reproducibly with `npm ci`;
- the canonical agent-runner source is mounted read-only and compiled into
  container-local `/tmp` for each run;
- ordinary assistant turns are tool-free, while protected, control, advanced,
  and code routes receive explicit capability allowlists;
- the host Codex profile, auth, configuration, project settings, and hooks are
  never copied or mounted into agent containers;
- host-owned settings, guidance, skills, plugins, commands, rules, project
  snapshot, and runner source are read-only;
- only scoped session/group state and the permitted IPC surface are writable;
- OneCLI is the preferred credential boundary. If it is unavailable, Andrea may
  inject exactly one selected credential through the container-runtime child
  environment and must classify that mode as degraded. Secret values never
  belong in command arguments or diagnostics.

Build and validate the supported image from the repository root:

```bash
npm run container:install
npm run typecheck:agent-runner
npm run build:agent-runner
npm run test:agent-runner
npm run check:container-contract
npm run build:container
npm run check:container-canary
npm run check:container-mounts
```

The mount canary is isolated from production data and external networking. It
proves immutable controls, canonical runner compilation, writable session-state
continuity, and restart continuity.

## Docker Desktop Sandboxes

Docker Desktop's separate `docker sandbox` micro-VM product is not currently a
release-supported Andrea host topology. Do not disable TLS validation, copy CA
or credential files into this repository, merge upstream channel branches, or
hand-edit runtime source based on historical sandbox instructions.

If that topology becomes a product requirement, treat it as a new, reviewed
deployment target. It must preserve the same trust boundaries and pass the
complete release matrix before being documented as supported.

Current setup and security references:

- [Setup and features](SETUP_AND_FEATURES_GUIDE.md)
- [Security model](SECURITY.md)
- [Testing and release runbook](TESTING_AND_RELEASE_RUNBOOK.md)
