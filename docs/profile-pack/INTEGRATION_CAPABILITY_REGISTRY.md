# Integration Capability Registry

Benchmark-guided packaging for the high-value knowledge-work integrations Andrea should expose clearly.

| Integration | Current status | Powers | Graceful degraded state | Proof target |
|---|---|---|---|---|
| Google Calendar | `live_proven` | calendar reads/writes, meeting prep, before-next-meeting guidance | Explain the blocker and fall back to planning guidance instead of pretending a write worked | One read plus one create/move/cancel chain |
| Messages / thread context | `live_proven` | reply help, summaries, open communication loops, same-thread defer/send | Keep it bounded and point back to Telegram when the bridge is unhealthy | One summary plus one draft/defer chain |
| GitHub / repo context | `degraded_but_usable` | repo standup, project status, coding/work readiness | Fall back to current work plus explicit repo context instead of bluffing | Grounded repo/work snapshot |
| Gmail inbox triage | `near_live_only` | inbox triage, owed replies, draft recommendations | Ask for pasted context and say inbox triage is not live on this host yet | Connected inbox search + brief + draft recommendation |
| Google Drive context | `near_live_only` | document-backed meeting prep and project briefs | Ask for pasted material or saved local notes instead of implying Drive access | Connected Drive-backed brief |
| Live research / watchlists | `externally_blocked` | what changed, watchlists, market scan, live compare/recommend | Say the provider lane is blocked and keep the answer grounded in saved context | One live lookup or watchlist brief with recent sources |
