# Changelog

This changelog tracks the standalone `Andrea_OpenAI_Bot` history after the
Codex-first runtime bootstrap. Earlier NanoClaw history lives in the upstream
project and is not duplicated here.

## 2026-03-30

- Bootstrapped `Andrea_OpenAI_Bot` from the NanoClaw shape as a standalone
  Codex/OpenAI-backed Andrea bot.
- Added provider-neutral runtime routing with `codex_local`,
  `openai_cloud`, and internal `claude_legacy` compatibility.
- Made Podman the default local container runtime for this repo.
- Added per-group runtime thread/job persistence and operator runtime commands.
- Added host Codex auth seeding into per-group `.codex` homes.
- Added truthful setup/runtime docs and focused runtime validation commands.
- Deferred `/runtime-artifacts` until there is a real cross-runtime artifact
  model.
