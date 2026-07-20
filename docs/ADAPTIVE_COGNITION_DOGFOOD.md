# Adaptive Cognition Dogfood Protocol

This is the operating contract for collecting the first Adaptive Cognition
live-use baseline. It requires 20 qualifying tasks, exactly two distinct tasks
on each qualifying working date, and at least 10 distinct qualifying working
dates.

The protocol cannot manufacture elapsed use. A deterministic test can prove
the accounting rules, but it cannot create a live task, a working date, proof,
or an owner verdict.

## Non-negotiable admission rule

A task counts only when all of the following are true:

- `runOrigin` is exactly `live`.
- `evidenceOrigin` is exactly `direct_live_observation`.
- the UTC `workingDate` is Monday through Friday and matches the UTC date in
  `completedAt`;
- the task ID and cognitive run ID are each distinct within the admitted set;
- at least one opaque verifier reference, evidence reference, and receipt
  reference is present;
- the owner gave an explicit `accepted`, `corrected`, `rejected`, or `blocked`
  verdict after the task completed, with an opaque verdict reference;
- the record satisfies the fixed metadata-only privacy contract; and
- no more than two tasks have already been admitted for that working date.

Synthetic runs, replays, backfills, inferred outcomes, telemetry-only records,
proof drills, duplicated task/run IDs, future-dated records, and records with a
missing proof class or verdict never count. Do not relabel any of them as live.
If canonical evidence was not captured at the time, leave the gap visible and
collect a new task on a future working date.

An explicit owner verdict is a distinct real review. Completion, a successful
verifier, lack of a complaint, assistant self-scoring, or later interpretation
does not imply one.

## Twenty-task sequence

Run two genuine owner-use tasks on each working date. These themes create
coverage without turning the sequence into canned fixtures. A task counts only
when it originates in actual live use and passes the admission rule above.

| Working day | Task A focus                              | Task B focus                                |
| ----------- | ----------------------------------------- | ------------------------------------------- |
| 1           | problem frame and definition of done      | decomposition and dependency order          |
| 2           | belief state and evidence gaps            | high-information read-only probe choice     |
| 3           | bounded plan construction                 | evidence-triggered replan                   |
| 4           | tool selection from current reliability   | fallback or honest blocking                 |
| 5           | checkpoint and interruption continuity    | safe resume with fresh state                |
| 6           | verifier and postcondition quality        | contradiction classification and repair     |
| 7           | cost, latency, and call-budget discipline | stop, clarify, or continue decision         |
| 8           | owner correction incorporation            | regression-evidence identification          |
| 9           | stale or missing evidence handling        | confidence calibration without overclaiming |
| 10          | end-to-end adaptive task                  | independent end-to-end adaptive task        |

The themes are prompts for coverage, not evidence. If a live task does not fit
the planned theme, classify it truthfully with one of the module's fixed task
families. Do not invent a task summary or copy the private request into this
ledger.

Exactly two tasks may count on one working date. A third otherwise valid task
is reported as `daily_task_limit_exceeded`; it does not replace either of the
first two. A date with only one task remains incomplete. Never backfill its
second task after the date has elapsed.

## Metadata-only record

`src/adaptive-cognition-dogfood.ts` exports a pure constructor and report
builder. The constructor accepts only:

- protocol, task, and run identity metadata;
- canonical UTC date and completion time;
- fixed task-family and outcome classes;
- the literal live/direct-observation provenance values;
- opaque verifier, evidence, and receipt references; and
- a fixed owner-verdict class, opaque verdict reference, and review time.

It rejects unknown fields. In particular, never include prompts, replies,
message bodies, contact details, tool arguments, tool output, commands, file
paths, provider debates, hidden reasoning, secrets, or free-form review text.
Opaque references require one to three short type prefixes followed by either
a 16-64 character hexadecimal digest or a canonical UUID. Arbitrary words,
paths, URLs, whitespace, short counters, and secret-shaped values are rejected.

Example construction:

```ts
const record = createAdaptiveCognitionDogfoodTaskRecord({
  taskId: 'task:9f86d081884c7d65',
  runId: 'run:3b5d5c3712955042',
  workingDate: '2026-07-06',
  completedAt: '2026-07-06T15:00:00.000Z',
  taskFamily: 'analysis',
  outcome: 'completed',
  runOrigin: 'live',
  evidenceOrigin: 'direct_live_observation',
  verifierRefs: ['verifier:4e07408562bedb8b'],
  evidenceRefs: ['evidence:4b227777d4dd1fc6'],
  receiptRefs: ['receipt:ef2d127de37b942b'],
  ownerVerdict: {
    verdict: 'accepted',
    verdictRef: 'verdict:e7f6c011776e8db7',
    recordedAt: '2026-07-06T15:05:00.000Z',
  },
});
```

This function returns an immutable value. It does not persist the value. A
future integration may project already-authoritative canonical records into
this shape, but it must not add a second truth store or infer missing fields.

## Progress report

Build a deterministic report with an explicit cutoff:

```ts
const report = buildAdaptiveCognitionDogfoodReport({
  candidates,
  asOf: '2026-07-17T23:59:00.000Z',
});
```

The report exposes:

- candidate, counted, excluded, and remaining task counts;
- distinct and fully completed working-date counts;
- the explicit owner-verdict count and verdict-class totals;
- outcome-class totals;
- task and working-date progress percentages;
- per-date task IDs and whether the date has exactly two admitted tasks;
- metadata-only exclusion and blocker codes; and
- one fixed next-action code.

`completionEligible` becomes true only when at least 20 tasks are admitted and
at least 10 working dates each contain exactly two admitted tasks. Every
counted task therefore has an explicit verdict and all three proof-reference
classes. Corrections, rejections, partial outcomes, failures, and blocked tasks
remain visible in the report; a numeric threshold does not erase them or make
a promotion decision.

Common blockers include:

- `not_live` or `not_direct_live_observation`;
- `missing_verifier_refs`, `missing_evidence_refs`, or
  `missing_receipt_refs`;
- `missing_owner_verdict`;
- `duplicate_task_id` or `duplicate_run_id`;
- `working_date_requires_second_task`;
- `daily_task_limit_exceeded`;
- negative live outcomes or owner verdicts; and
- remaining task or working-date targets.

Reports never echo rejected candidate fields. An unsafe extra field is reduced
to `unknown_metadata_field` plus a safe candidate ordinal or opaque task ID.

## Daily operating loop

For each current working date:

1. Complete the first bounded, read-only or local-analysis live task.
2. Capture canonical verifier, evidence, and receipt IDs at completion.
3. Ask for and record the owner's separate explicit verdict through the
   already-authorized owner-review surface.
4. Complete one genuinely distinct second task and repeat the capture/review.
5. Build the report with the current canonical cutoff.
6. Report the counts and blocker codes honestly. Do not fill gaps from memory.
7. Stop after two admitted tasks for that date and continue on the next
   working date.

If a task would require an external side effect, keep this protocol on the
read-only planning, analysis, or verification side of the boundary. Existing
approval systems remain authoritative; participation in dogfood grants no
authority.

## Safety boundary

The module has no imports and performs no I/O. Its exported boundary declares:

- no record persistence;
- no message sends;
- no calendar writes;
- no service or system restarts;
- no commits or code pushes; and
- no external-system mutation.

The protocol must not be used as an excuse to call a provider, contact a
person, modify a calendar, restart Andrea, deploy code, change credentials, or
exercise a protected action. It accounts for evidence that an authorized
runtime already produced; it creates no authority and performs no action.

## Verification

Run the focused, network-denied Vitest suite:

```bash
npm run test:adaptive-cognition:dogfood
```

The suite verifies the exact 20-task/10-working-date threshold, two-task daily
cap, distinct task/run IDs, live-only and direct-observation provenance,
weekend/future rejection, proof and owner-verdict requirements, blocker
reporting, metadata-only output, and the zero-mutation boundary.
