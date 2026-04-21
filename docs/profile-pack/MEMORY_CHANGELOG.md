# Andrea Memory Changelog

Append-only changelog for the benchmark-guided memory model.

## 2026-04-17

- Introduced the canonical three-tier memory model for Andrea: working, semantic, and procedural.
- Declared the product-layer ownership boundary: raw personal memory stays in NanoBot storage and docs, while `andrea_platform` receives only metadata, freshness, and proof-oriented rollups.
- Added a canonical memory index, ownership/freshness model, task-state structure, and platform-facing memory freshness rollup.
- Packaged benchmark-guided capability clusters around meeting prep, repo standup, life threads, idea capture, watchlists, and reply help without importing Cowork slash-command UX.

## Rules

- Never rewrite old entries.
- Append only when memory structure, ownership, or freshness rules change in a meaningful way.
- User data changes belong in the product-layer stores; this file records the memory system shape, not private content.
