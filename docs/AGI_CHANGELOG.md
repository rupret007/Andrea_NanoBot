# Changelog — AGI Layer

## [2.0.0] — Initial AGI layer

### Added

- `src/agi-core/` — deliberate reasoning subsystem
  - `tree-of-thoughts.ts` — beam-search ToT with budget enforcement
  - `council.ts` — multi-model council with synthesis fallback
  - `planner.ts` — ReAct + plan-and-execute
  - `self-critique.ts` — self-refine with thrash protection
  - `cognitive-core.ts` — strategy classifier and orchestrator
- `src/memory/` — vector + graph + episodic memory facade
- `src/models/` — provider-agnostic router with Anthropic, OpenAI, Ollama adapters
- `src/integrations/` — Notion, Linear, GitHub, Spotify, Home Assistant, Google Drive, web research, MCP bridge
- `src/safety/` — constitution v2026-05-08.1, action policy gate, injection scanner, hash-chained audit log, budget meter
- `src/reflection/reflector.ts` — nightly distill / critique / propose loop
- `src/agi-runtime.ts` — composition root
- `src/agi-bootstrap.ts` — env-driven setup
- `docs/AGI_ROADMAP.md`, `docs/AGI_ARCHITECTURE.md`, `docs/AGI_INTEGRATION_GUIDE.md`, `docs/AGI_SECURITY.md`, `docs/AGI_EVALUATION.md`
- `tests/agi-*.test.ts` — unit tests for new subsystems
- `.github/workflows/agi-ci.yml` — typecheck / lint / test / security-scan

### Changed

- None. Strict additive change — legacy code unaffected.

### Notes

- Model defaults use the 2026 catalog (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). Override via `ANDREA_PRIMARY_MODEL` etc.
- The reflector never auto-merges. PR drafts land in `reflections/`.
- All new modules respect the existing OneCLI credential gateway when `ANDREA_USE_ONECLI=1`.
