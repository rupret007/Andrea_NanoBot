# Andrea Knowledge Library

Andrea now has a bounded **Knowledge Library** for saved source material.

## Where This Shows Up In Signature Flows

Knowledge Library is the core of the saveable research journey:

- ask a research question
- get the short answer on Alexa or the calmer answer on Telegram
- ask for the fuller version
- save the useful result to the library
- come back later and ask what your saved material says

This is not the same thing as memory, life threads, reminders, or current work.

- **memory/profile** stores durable facts and preferences
- **life threads** track ongoing matters
- **reminders** schedule future nudges
- **current work** tracks active execution
- **Knowledge Library** stores saved notes, imported text sources, saved research, and other user-approved reference material

## What The Knowledge Library Stores

Each saved source keeps explicit metadata:

- `source_id`
- `source_type`
  - `uploaded_document`
  - `generated_note`
  - `saved_research_result`
  - `imported_summary`
  - `manual_reference`
- `title`
- `shortSummary`
- normalized text content or `contentRef`
- `tags`
- `scope`
  - `personal`
  - `household`
  - `work`
  - `mixed`
- `sensitivity`
  - `normal`
  - `private`
  - `sensitive`
- `ingestionState`
- `indexState`
- `createdAt`
- `updatedAt`
- `lastUsedAt`
- optional chunk records for retrieval

The v1 storage lives in the main SQLite database:

- `knowledge_sources`
- `knowledge_chunks`
- `knowledge_chunks_fts`

## What Counts As Ingestion

The v1 library is **explicit only**.

Andrea does not silently crawl folders or ingest chats in the background.

Current supported ingestion paths:

- explicitly saved research results
- manually added notes or summaries
- approved local text files
- explicitly saved Andrea-generated outputs

Current file support is intentionally text-first:

- `.txt`
- `.md`
- `.markdown`
- `.json`
- `.csv`
- `.log`
- `.yaml`
- `.yml`
- `.rst`

Unsupported binary or complex formats are rejected cleanly.

Andrea also refuses obvious secrets or credentials during library ingestion.

## How Retrieval Works

The v1 retrieval strategy is **lexical-first** and local:

- normalized source text is chunked into bounded sections
- chunks are indexed with SQLite FTS5
- retrieval ranks chunks by lexical match, then lightly favors title/tag matches and recent source use
- disabled, deleted, failed, or stale-unindexed sources are excluded from normal retrieval

Every retrieval hit keeps provenance:

- source title
- source id
- source type
- scope
- chunk id
- excerpt
- retrieval score
- match reason

This keeps source-grounded answers explainable instead of collapsing everything into one blob.

## Research Routing

The research orchestrator can now choose among:

- `local_context`
- `knowledge_library`
- `openai_responses`
- `runtime_delegate`

Knowledge-library routing is preferred when the user asks things like:

- `save this to my library`
- `what do my saved notes say about this`
- `what did I save about this`
- `compare these saved sources`
- `use only my saved material`
- `combine my notes with outside research`

The route explanation stays explicit:

- why saved material was used
- which saved sources matched
- whether outside research was intentionally excluded or combined

## Telegram And Alexa Behavior

Telegram is the richer library surface.

Typical Telegram output includes:

- summary first
- structured findings
- supporting sources
- route explanation
- follow-up suggestions such as save, compare, or combine with outside research

Alexa stays source-aware but voice-safe.

Typical Alexa behavior:

- short spoken summary
- mention that Andrea is using saved material
- name at most one or two source titles when helpful
- hand off to Telegram when the detailed source view would be too long for voice

## User Controls

Current natural control surface includes:

- `save this to my library`
- `what have I saved about this`
- `what sources are you using`
- `show me the relevant saved items`
- `use only my saved material`
- `combine my notes with outside research`
- `stop using that source`
- `forget that source`
- `reindex that source`

These flows map into explicit shared capabilities rather than hidden behavior.

## Debug And Validation

Pinned-Node harness:

```bash
npm run debug:knowledge-library
```

Focused tests:

- `src/knowledge-library.test.ts`
- `src/research-orchestrator.test.ts`
- `src/assistant-capabilities.test.ts`
- `src/assistant-capability-router.test.ts`

Typical full validation:

```bash
npm run typecheck
npm run build
npm test
```

## Current Limits

- retrieval is lexical-first today; semantic retrieval is a future hook
- ingestion is explicit and manual; there is no background sync
- library answers are grounded in saved material, not raw chat history
- Knowledge Library does not replace memory, life threads, reminders, or current work
