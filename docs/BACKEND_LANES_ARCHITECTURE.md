# Backend Lanes Architecture

Andrea_NanoBot is now the merged home for Andrea's Telegram-first orchestration shell.

This repo owns the shell. Backend lanes own execution truth.

## Shell Ownership

The shell stays responsible for:

- Telegram UX
- `/cursor` tile dashboard
- jobs browser and current-job view
- reply-linked operator behavior
- current selection and wizard state
- operator context persistence
- button routing and dashboard message editing

## Backend Lane Ownership

Backend lanes own:

- execution truth
- job lifecycle
- logs and stop behavior
- thread or conversation continuity
- runtime- or provider-specific metadata
- truthful status about what is actually configured or validated

## Current Lanes

### Cursor

- first-class rich backend lane
- primary taught operator workflow
- powers the `/cursor` tile dashboard, Cloud job controls, and desktop bridge controls

### `andrea_runtime`

- integrated Codex/OpenAI backend lane
- now has a `Codex/OpenAI` surface inside the primary `/cursor` work shell
- `/runtime-*` remains the explicit runtime fallback shell
- does not replace Cursor or the `/cursor` dashboard
- prefers `codex_local`
- keeps `openai_cloud` conditional on credentials and host validation

## Shared Handle Model

The shell now treats job references as:

```text
{ laneId, jobId }
```

Rules:

- `laneId` identifies the backend lane, such as `cursor` or `andrea_runtime`
- `jobId` is the opaque per-lane execution handle
- `threadId` or other continuity metadata stays lane-specific secondary metadata
- replying to a fresh task card always continues that specific task; otherwise the shell uses the current work selected in the opened lane

## Persistence

Selection and message context stay in Andrea_NanoBot's existing operator-context tables.

They are now lane-aware through:

- `cursor_operator_contexts.selected_lane_id`
- `cursor_operator_contexts.selected_jobs_by_lane_json`
- `cursor_message_contexts.lane_id`

Legacy rows with no stored lane are treated as `cursor`.

## Temporary Imported Subtree

`imported/andrea_openai_bot` exists for:

- bounded history preservation
- migration reference
- audit comparison while the lane integration settles

It is **not** the long-term runtime home.

The integrated `andrea_runtime` lane should run from the main repo's namespaced modules under `src/andrea-runtime/`, not from permanent imports into the subtree.

## Operator Surface Today

What is primary today:

- `/cursor`
- Cursor jobs browser
- Cursor current-job controls
- Cursor reply-linked follow-up
- the embedded `Codex/OpenAI` dashboard views inside `/cursor`

What is secondary today:

- `/runtime-status`
- `/runtime-jobs`
- `/runtime-followup`
- `/runtime-stop`
- `/runtime-logs`

Those `/runtime-*` commands are the explicit runtime fallback shell for the `andrea_runtime` lane inside the shared cockpit.

## What Is Validated Today

- the merged shell still preserves the current Cursor dashboard UX
- the same shell now surfaces a small first-class Codex/OpenAI lane view without replacing Cursor as the primary taught path
- shared lane types and registry exist in the main repo
- Cursor is wrapped behind the lane architecture without losing its richer controls
- the integrated `andrea_runtime` lane satisfies the shared lane contract in focused tests

## What Remains Conditional

- live `andrea_runtime` execution remains conditional on host runtime validation and `ANDREA_RUNTIME_EXECUTION_ENABLED=true`
- `openai_cloud` remains conditional on `OPENAI_API_KEY` or a compatible gateway token
- the imported subtree is still present temporarily until the migration reference is no longer needed

## Design Rule Going Forward

Do not flatten Cursor to the lowest common denominator.

The shared lane layer should support:

- common operations that every backend can honor
- backend-specific capabilities where a richer lane already exists
- one coherent task mental model in the shell, while preserving truthful lane differences underneath

That is how Andrea can keep a clean shared shell while still preserving Cursor depth and leaving room for future `andrea_runtime` shell UX.
