# Competitive Scorecard

`Andrea-Assistant` is a benchmark for memory clarity, integration packaging, and ritual/task readability.
It is not a merge target and not the runtime center of gravity for Andrea.

## Scoring rubric

Scale:
- `5` = clearly stronger today
- `4` = strong and credible, with smaller gaps left
- `3` = competitive but still uneven
- `2` = noticeably behind
- `1` = missing or not credible

## Current comparison

| Category | Andrea | Andrea-Assistant benchmark | Notes |
| --- | --- | --- | --- |
| Architecture coherence | 5 | 2 | Andrea has a real shell/runtime/platform split with typed platform state and bus-backed snapshots. |
| Reliability and fault handling | 5 | 2 | Andrea already exposes proof state, degraded modes, and runtime-backed truth instead of just capability packaging. |
| Platform shape | 5 | 1 | `andrea_platform` gives Andrea lifecycle, health, replay, and observability that the benchmark repo does not provide. |
| Demoability under real failure | 4 | 2 | Andrea can explain blocked lanes and partial availability honestly, though some integration lanes are still externally constrained. |
| Memory clarity | 4 | 5 | The benchmark is still a useful guide here; Andrea now has a three-tier memory pack and freshness model, but we should keep improving inspectability. |
| Integration packaging | 4 | 4 | Andrea now has an explicit integration capability registry and proof criteria, while the benchmark remains a clean reference for concise packaging. |
| Ritual and task readability | 4 | 5 | Andrea now has a typed ritual manifest and task-state mapping, but the benchmark still sets a good bar for human readability. |
| Operator ergonomics | 4 | 3 | Andrea has stronger system truth and operational context, while the benchmark is simpler to scan at a glance. |

## What Andrea should keep borrowing as a benchmark

- Memory should stay structured and inspectable.
- Integrations should be described in terms of journeys, permissions, degraded behavior, and proof.
- Rituals and task states should stay readable enough for a human to audit quickly.
- Capability packaging should stay concise, chat-first, and grounded in real user journeys.

## What Andrea should not copy

- Cowork-specific command UX as the public product surface.
- A single-repo shape that collapses shell, execution, and platform authority together.
- Any illusion of richer integrations than the host can actually prove live.

## Near-term target

Andrea should continue to win decisively on:

- architecture coherence
- reliability and fault handling
- platform shape
- real execution truth

Andrea should keep closing the gap on:

- memory clarity
- integration packaging
- ritual and task readability
- polished discovery/help wording
