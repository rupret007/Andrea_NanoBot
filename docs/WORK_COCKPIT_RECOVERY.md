# Work cockpit recovery

## Product change

The existing Telegram work cockpit keeps a selected Codex/OpenAI task usable
through a temporary backend outage. It distinguishes three outcomes:

| Exact task read | What the owner sees | Selection |
| --- | --- | --- |
| Valid current task | Existing task card and normal permitted controls | Retained |
| Backend confirms missing | Existing empty-task guidance | Only the matching pointer is cleared |
| Failed, unavailable, or invalid response | Exact retained task ID, execution status unknown, Check again | Retained |

Check again is a status read, not a task restart or continuation. The current
task path calls the existing lane's exact `getJob`; it no longer lists jobs
first or invokes inventory bootstrap. The explicit Recent Work view still uses
the existing list route and its existing bootstrap behavior. A failed list is
not presented as an empty history.
The full panel may also read existing Cursor inventory and runtime readiness;
the exact-task resolver's one-read fixture proof is not a claim that the whole
panel makes only one provider request.

## Trust and continuity

- Current Work, the runtime overview, and Current Task share the recovery
  presentation. Home summarizes the unavailable runtime without replacing an
  explicitly selected Cursor task.
- Cached evidence comes from the existing runtime-job table, matched on
  backend, task, group, and chat. Only a validated historical timestamp/status
  projection is allowed; the card shows the timestamp, not cached execution
  status. It does not display cached prompts, outputs, errors, or paths.
- Invalid or future historical timestamps are omitted. No cached value is
  proof that a task is currently running, stopped, or complete.
- A changed selection supersedes an in-flight read. A late missing result does
  not erase a newer runtime choice or silently replace Cursor focus.
- Newer panel reads supersede older same-task responses. Panel delivery is
  serialized per chat/thread so displayed recovery wording and its saved
  guidance-only reply context stay paired.
- Recovery-card replies are guidance-only until a fresh task view is obtained.
  No automatic task replay, retry loop, continuation, or stop is added.
- A backend route/proxy/group 404 is not a deleted task. Only the existing
  canonical item-specific missing-task response clears the matching pointer;
  custom or ambiguous error wording remains unavailable.
- Existing chat/group access checks, exact message-send fence, and Private API
  OFF boundary remain unchanged. No new database, provider, dependency, or
  background service is required.

## Verification and handoff

Focused offline proof uses the real selection-table path with an in-memory
database, fake backend reads, and the repository network-denial guard:

```bash
npm test -- src/work-cockpit-recovery.test.ts src/work-cockpit-recovery.integration.test.ts src/cursor-dashboard.test.ts src/work-cockpit-targets.test.ts src/backend-lanes/andrea-runtime-lane.test.ts
npm run test:major:ci
npm run docs:check
```

The change is a draft review candidate, not a deployed recovery fix. Exact-tip
local and hosted results belong in the pull request and coordination handoff;
historical README totals are not current evidence. No live Telegram/provider
session, owner data, service restart, or actual production-task recovery is
claimed from fixtures.

Remaining owner proof, after normal review and an explicitly authorized
deployment: observe a real selected task through a temporary unavailable read
and a successful status retry. Do not create a production outage to obtain
that proof. The separate web owner cockpit's refresh/mutation recovery and
broader Cursor transport behavior were not changed in this slice.
