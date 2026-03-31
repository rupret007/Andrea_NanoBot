# Orchestration Contract

This repo now exposes a transport-agnostic runtime orchestration boundary for external callers such as NanoClaw.

This is **not** a finished cross-repo transport. There is no HTTP, CLI, or stdio wrapper in this pass. The contract lives as an internal callable service inside `Andrea_OpenAI_Bot`.

## Purpose

NanoClaw is expected to own:

- Telegram operator UX
- dashboard/current-selection state
- reply-linked operator flows

Andrea is expected to own:

- durable runtime job records
- Codex/OpenAI runtime execution
- real thread reuse
- honest logs and failure state

## Service Surface

The new orchestration service exposes:

- `createJob(request)`
- `followUp(request)`
- `getJob(jobId)`
- `listJobs(query)`
- `getJobLogs(query)`
- `stopJob(request)`

Phase 1 is async and job-centric:

- `createJob` and `followUp` return a durable Andrea job record immediately
- callers poll `getJob`, `listJobs`, and `getJobLogs`
- `stopJob` marks `stopRequested` and reports whether a live stop signal was accepted

## Request Types

Core source metadata:

```ts
type OrchestrationSource = {
  system: string;
  actorRef?: string | null;
  correlationId?: string | null;
  replyRef?: string | null;
};
```

Create:

```ts
type CreateRuntimeJobRequest = {
  groupFolder: string;
  prompt: string;
  source: OrchestrationSource;
  routeHint?: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
};
```

Follow-up:

```ts
type FollowUpRuntimeJobRequest = {
  prompt: string;
  source: OrchestrationSource;
  jobId?: string;
  threadId?: string;
  groupFolder?: string;
};
```

List / logs / stop:

```ts
type ListRuntimeJobsRequest = {
  groupFolder?: string;
  threadId?: string;
  limit?: number;
  beforeJobId?: string;
};

type GetRuntimeJobLogsRequest = {
  jobId: string;
  lines?: number;
};

type StopRuntimeJobRequest = {
  jobId: string;
  source?: OrchestrationSource;
};
```

## Response Model

Each durable job record includes:

```ts
type RuntimeOrchestrationJob = {
  jobId: string;
  kind: 'create' | 'follow_up';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stopRequested: boolean;
  groupFolder: string;
  groupJid: string;
  parentJobId?: string | null;
  threadId?: string | null;
  runtimeRoute: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
  selectedRuntime?: AgentRuntimeName | null;
  promptPreview: string;
  latestOutputText?: string | null;
  finalOutputText?: string | null;
  errorText?: string | null;
  logFile?: string | null;
  sourceSystem: string;
  correlationId?: string | null;
  replyRef?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
};
```

`listJobs` returns:

```ts
type RuntimeOrchestrationJobList = {
  jobs: RuntimeOrchestrationJob[];
  nextBeforeJobId?: string | null;
};
```

## Resolution And Reuse Rules

- `createJob` targets an Andrea `groupFolder`
- `followUp` resolution order is:
  - `jobId`
  - `threadId`
  - `groupFolder`
- invalid or conflicting follow-up targets are rejected
- `requestedRuntime` is advisory only in this pass
- actual runtime selection still follows Andrea’s current route/runtime logic
- `threadId` is populated when real execution knows it or reuses it truthfully

## Guarantees In Phase 1

- durable SQLite-backed job records
- honest `queued/running/succeeded/failed` lifecycle
- real thread reuse when the selected runtime allows it
- job-specific log retrieval when a log file exists
- truthful `openai_cloud` credential failures
- no reintroduction of Claude remote-control concepts

## Conditional Or Deferred

- `openai_cloud` still requires `OPENAI_API_KEY` or a compatible gateway token
- this contract does not yet provide HTTP, CLI, stdio, or daemon transport
- there is no separate session browser yet; callers use `jobId`, `threadId`, and `listJobs`
- `/runtime-artifacts` remains deferred

## What A Future NanoClaw Caller Must Provide

- an Andrea `groupFolder`
- prompt text
- `source.system` and any caller correlation metadata it wants preserved
- optional `jobId` or `threadId` for follow-ups

The recommended Phase 2 on the NanoClaw side is to keep the dashboard and button flows in NanoClaw, and treat this repo as the durable runtime backend it polls.
