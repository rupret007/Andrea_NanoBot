# Wiring the AGI layer into existing NanoClaw

These changes are additive. Nothing in the legacy code needs to be removed; channels keep working until you migrate them one by one.

## 1. Drop the new modules in

The `agi-upgrade/` tree mirrors the layout of the existing `src/`. Copy:

```
src/agi-core/      → src/agi-core/
src/memory/        → src/memory/
src/models/        → src/models/
src/integrations/  → src/integrations/
src/safety/        → src/safety/
src/reflection/    → src/reflection/
src/agi-runtime.ts → src/agi-runtime.ts
src/agi-bootstrap.ts → src/agi-bootstrap.ts
docs/AGI_*.md      → docs/
.github/workflows/ → .github/workflows/  (merge with existing)
tests/             → tests/
```

`tsconfig.json` already covers `src/**/*`; no compiler config change required. Run:

```bash
npm install                  # picks up nothing new — no new deps
npm run typecheck            # should pass against the new tree
npm run test -- agi          # run only the new tests
```

## 2. Bootstrap once at process start

In `src/index.ts`, after channel registry init:

```ts
import { bootstrapAgi } from "./agi-bootstrap.js";

const agi = await bootstrapAgi();
state.agi = agi;
```

`state.agi` is now a singleton with the cognitive core + memory + integrations + safety wired together.

## 3. Migrate one channel at a time

Pick a low-stakes channel first (e.g. Telegram). Replace the existing
"call agent SDK" path:

```ts
// Before
const reply = await agentSDK.run(messageText, { ... });

// After
const { reply } = await state.agi.ask({
  scope: chatId,
  text: messageText,
  source: `telegram:${chatId}`,
  history: lastFewTurns,
  initiatedByUser: true,
});
```

The legacy SDK call still works for channels you haven't migrated.

## 4. Migrate skills as integrations

Most existing skills are direct API calls. Wrap each as an `Integration` (see `src/integrations/notion.ts` for the smallest example). Once registered, the cognitive core can choose them automatically — no skill-routing code in the channel layer.

## 5. Schedule the reflector

In `src/task-scheduler.ts`, register a daily 3am job:

```ts
schedule.daily("03:00", async () => {
  const dayStart = startOfYesterday().getTime();
  const dayEnd = startOfToday().getTime();
  for (const scope of activeScopes()) {
    const patch = await state.agi.reflector.runDaily(scope, dayStart, dayEnd);
    await fs.writeFile(
      `reflections/${patch.date}-${scope}.md`,
      `# ${patch.date} ${scope}\n\n${patch.summary}\n\n${patch.proposal}`,
    );
  }
});
```

Reflections land in `reflections/` for human review. **Do not auto-apply.**

## 6. Audit dashboard (optional)

The audit log is JSONL with hash-chained entries. Tail it with:

```bash
tail -f ~/.andrea/audit/audit.jsonl | jq .
```

A future PR could add a small web UI under `scripts/dashboard.ts`, but the JSONL format is already the source of truth.

## 7. Roll out

| Day | Action |
|---|---|
| 0 | Land the AGI tree behind a feature flag (`ANDREA_USE_AGI=1`) |
| 1 | Migrate Telegram channel; observe traces for a day |
| 2 | Migrate Slack + Discord |
| 3 | Migrate WhatsApp + Gmail |
| 4 | Migrate Alexa (uses `direct` strategy by default for latency) |
| 5 | Schedule the reflector |
| 7 | Remove the feature flag |
