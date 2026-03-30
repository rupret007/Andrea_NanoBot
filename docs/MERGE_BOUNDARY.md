# Merge Boundary

This repo is the standalone Codex/OpenAI-backed Andrea bot for now.

The intended merge target later is `Andrea_NanoBot`, which remains the separate Cursor/design/infra sibling repo.

## Pieces Intended To Merge Back

- provider-neutral runtime routing
- Podman-first container behavior
- per-group runtime thread/job persistence
- Codex auth seeding into per-group `.codex`
- operator runtime command surface
- runtime validation scripts and patterns

## Pieces That Stay Product-Level In Andrea_Nano

- broader Telegram product design
- Cursor cloud and desktop lanes
- app-level onboarding/menu choices
- multi-surface infrastructure decisions

## Contract To Preserve

- runtime request shape
- runtime thread/job persistence shape
- operator command semantics
- route policy semantics:
  - `local_required`
  - `cloud_allowed`
  - `cloud_preferred`

## Temporary Standalone Conveniences

These are useful here now, even if they later move or shrink:

- standalone README/docs framing
- direct runtime validation script
- local standalone bot packaging metadata
