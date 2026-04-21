# Andrea Memory Index

Canonical benchmark-guided memory map for the live Andrea product.

## Working Memory

| Entity | Authority | Freshness rule |
|---|---|---|
| Active session context | Chat/session state | Refresh every live turn |
| Current priorities | Daily guidance and current work | Refresh when the active picture changes |
| Current open loops | Life threads, reminders, follow-through | Refresh whenever open-loop state changes |
| Current mode and continuity | Router/session context | Refresh when the lane or mode changes |

## Semantic Memory

| Entity | Authority | Freshness rule |
|---|---|---|
| People | Profile subjects + profile facts | Update on accepted facts and explicit corrections |
| Projects | Life threads + knowledge library | Update on real project changes |
| Domains/context | Knowledge library + accepted profile facts | Update when new grounded context is saved |
| Life threads | `life_threads` records | Update on signal, follow-up, and status changes |
| Knowledge/library entries | `knowledge_sources` + chunks | Update on save, disable, delete, and reindex |
| Glossary/canonical terms | Profile pack + saved notes | Update only when the language model of the domain changes |

## Procedural Memory

| Entity | Authority | Freshness rule |
|---|---|---|
| Delegation rules | Accepted profile facts + delegation flows | Update only when the trust model changes |
| Playbooks | Product-layer playbooks and operator docs | Update when behavior should change |
| Rituals | `ritual_profiles` + ritual manifest | Update on configuration changes |
| Preferences | Accepted profile facts | Update on explicit user preference changes |
| Decision patterns | Outcome reviews + accepted guidance rules | Update after confirmed learnings |
| Outcome-review learnings | Outcome-review records | Append when real postmortems produce a stable rule |

## Task States

| State | Andrea meaning |
|---|---|
| `active` | Current focus, running follow-through, or immediately actionable open loop |
| `waiting` | Blocked or pending follow-up |
| `someday` | Backlog or later idea |
| `done` | Closed loop or archived outcome |
