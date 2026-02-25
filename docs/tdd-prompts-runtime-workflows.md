# TDD Prompts — Runtime Workflows for neolata-mem

> Codex-ready prompts implementing three agent-runtime features:
> 1. **Heartbeat auto-store** — capture session state on idle
> 2. **Topic-aware contextual recall** — blended startup recall
> 3. **Pre-compaction structured dump** — persist takeaways before context loss
>
> Each prompt builds on the previous. Test-first. No orphan code.

---

## Context for All Prompts

```text
You are working on neolata-mem, a graph-native memory engine for AI agents.
Repo: @jeremiaheth/neolata-mem (npm), source at src/.

Key existing APIs on MemoryGraph (returned by createMemory()):
- store(agent, text, { category, importance, tags, eventTime, claim, provenance, quarantine, onConflict })
- search(agent, query, { limit, minSimilarity, before, after, rerank, statusFilter, sessionId, explain })
- context(agent, query, { maxMemories, before, after, maxTokens, explain })
- ingest(agent, text, { minImportance }) — extraction provider → structured facts → store each
- storeMany(agent, items, { embeddingBatchSize })
- estimateTokens(text) — word-count heuristic (~0.75 tokens/word)

Storage backends: jsonStorage, memoryStorage (in-memory/test), supabaseStorage.
Embeddings: openaiEmbeddings, noopEmbeddings.
Extraction: llmExtraction, passthroughExtraction.
Test runner: vitest. Existing tests in test/. Use memoryStorage() + noopEmbeddings() for unit tests.

The new module goes in src/runtime.mjs and is re-exported from src/index.mjs.
Tests go in test/runtime.test.mjs (and later test/runtime-*.test.mjs for sub-features).

IMPORTANT: The runtime module does NOT own timers, conversation loops, or token meters.
It exposes pure functions/helpers that the host agent calls at the right time.
```

---

## Prompt 1 — Module scaffold + key-moment detector

```text
Create src/runtime.mjs and test/runtime-detect.test.mjs.

Implement and test a deterministic key-moment detector:

export function detectKeyMoments(text, { role = 'assistant' } = {})

Returns an array of { type, text, importance } objects. Types:
- "decision" — assistant output contains "Decision:", "We decided", "Going with", "Let's do", "Ship it"
- "preference" — user says "I prefer", "I like", "I want", "Always use"
- "commitment" — "I will", "We will", "TODO:", "Action item:"
- "blocker" — "Blocked by", "Blocker:", "Can't proceed", "Waiting on"

Rules:
- Case-insensitive matching
- Each match extracts the sentence containing the trigger (not the whole text)
- Default importance: decision=0.9, preference=0.7, commitment=0.8, blocker=0.85
- If no moments detected, return empty array
- role='user' enables preference/commitment patterns; role='assistant' enables decision/blocker patterns; both roles detect all patterns

Tests (at least 8):
1. Assistant text with "Decision: use Supabase" → [{ type: 'decision', importance: 0.9, text: contains 'Supabase' }]
2. User text with "I prefer dark mode" → [{ type: 'preference', importance: 0.7 }]
3. Text with multiple moments → returns all of them
4. Text with no moments → []
5. Case insensitive: "DECISION:" works
6. Commitment: "TODO: fix the bug" → [{ type: 'commitment' }]
7. Blocker: "Blocked by RLS permissions" → [{ type: 'blocker' }]
8. Extracts the containing sentence, not the full paragraph

Do NOT wire into index.mjs yet. Just the module + tests.
```

---

## Prompt 2 — Heartbeat auto-store helper

```text
In src/runtime.mjs, add and test:

export async function heartbeatStore(mem, agent, turns, config = {})

Parameters:
- mem: a MemoryGraph instance
- agent: string agent ID
- turns: array of { role: 'user'|'assistant'|'tool', content: string, timestamp?: string }
- config: {
    sessionId?: string,        // tags memories with session:<id>
    topicSlug?: string,        // tags memories with topic:<slug>
    projectSlug?: string,      // tags memories with project:<slug>
    minNewTurns?: number,      // minimum turns since last call to bother (default: 3)
    lastStoredIndex?: number,  // index of last turn we already processed (default: -1)
  }

Behavior:
1. Slice turns to only new ones (after lastStoredIndex)
2. If fewer than minNewTurns new turns, return { stored: 0, skipped: 'insufficient_turns', lastIndex: lastStoredIndex }
3. Run detectKeyMoments() on each new turn (pass role)
4. For each detected moment, call mem.store(agent, moment.text, {
     category: moment.type === 'blocker' ? 'open_thread' : moment.type,
     importance: moment.importance,
     tags: [sessionId, topicSlug, projectSlug tags as applicable, 'source:' + role],
     provenance: { source: role === 'user' ? 'user_explicit' : 'system' },
   })
5. If no moments detected from any turn, store a single compact summary:
   - Concatenate the new turns into a brief text (truncate to 500 chars)
   - Store as category='session_snapshot', importance=0.5
6. Return { stored: number, ids: string[], lastIndex: number, moments: array }

Tests (test/runtime-heartbeat.test.mjs, use memoryStorage + noopEmbeddings):
1. 3 turns with a decision → stores the decision memory, returns stored=1
2. Fewer than minNewTurns → returns skipped='insufficient_turns'
3. No key moments → stores a session_snapshot fallback
4. Multiple moments across turns → stores all of them
5. Tags include session/topic/project when provided
6. lastStoredIndex=5, turns has 10 items → only processes turns 6-9
7. Provenance source reflects the turn's role
8. Returns correct lastIndex (index of last processed turn)
```

---

## Prompt 3 — Topic extraction + blended recall

```text
In src/runtime.mjs, add and test:

export function extractTopicSlug(text, { synonyms = {} } = {})

- Extracts a topic slug from text using keyword frequency
- Normalize: lowercase, strip punctuation, split words
- Remove stop words (the, a, an, is, are, was, were, to, for, in, on, of, and, or, but, with, this, that, it, we, i, you, my)
- Pick the top word by frequency (ties broken alphabetically)
- Check synonyms map: { slug: [aliases] } — if top word matches an alias, return the slug
- Return the slug (or null if text is empty/all stop words)

export async function contextualRecall(mem, agent, seedText, config = {})

Parameters:
- mem: MemoryGraph instance
- agent: string
- seedText: string (first user message or task description)
- config: {
    maxTokens?: number,        // total budget (default: 2000)
    recentCount?: number,      // channel A count (default: 5)
    semanticCount?: number,    // channel B count (default: 8)
    importantCount?: number,   // channel C count (default: 10)
    importanceThreshold?: number, // channel C filter (default: 0.8)
    synonyms?: object,         // passed to extractTopicSlug
  }

Behavior:
1. Extract topicSlug from seedText
2. Channel A (recency): mem.search(agent, '', { limit: recentCount, rerank: false })
3. Channel B (semantic): mem.search(agent, seedText, { limit: semanticCount, rerank: true })
4. Channel C (importance): mem.search(agent, topicSlug || seedText, { limit: importantCount, rerank: true })
   - Post-filter: only keep results with importance >= importanceThreshold
5. Merge all results, dedupe by id
6. Use mem.context() if maxTokens is set — otherwise just return merged results
   - If maxTokens set: call mem.context(agent, seedText, { maxTokens, maxMemories: merged.length })
   - Note: context() does its own retrieval, so instead just format+pack manually:
     Sort merged by composite score descending, accumulate with estimateTokens() until budget hit
7. Return { topicSlug, memories: array, totalTokens: number, excluded: number }

Tests (test/runtime-recall.test.mjs):
1. extractTopicSlug("Fix the OCI deployment pipeline") → 'oci' or 'deployment' or 'pipeline' (most frequent non-stop word)
2. extractTopicSlug with synonyms { oci: ['oracle', 'tenancy'] } + text containing 'oracle' → 'oci'
3. extractTopicSlug("") → null
4. extractTopicSlug("the a an is") → null (all stop words)
5. contextualRecall with seeded memories → returns blended results from all 3 channels
6. contextualRecall deduplicates (same memory from recent + semantic counted once)
7. contextualRecall respects maxTokens budget
8. contextualRecall returns topicSlug in result
9. Channel C filters by importance threshold
```

---

## Prompt 4 — Pre-compaction dump

```text
In src/runtime.mjs, add and test:

export async function preCompactionDump(mem, agent, turns, config = {})

Parameters:
- mem: MemoryGraph instance
- agent: string
- turns: array of { role, content, timestamp? }
- config: {
    sessionId?: string,
    topicSlug?: string,
    projectSlug?: string,
    maxTakeaways?: number,     // max individual memories to store (default: 10)
  }

Behavior:
1. Run detectKeyMoments() on ALL turns (not just new ones) to extract decisions, preferences, commitments, blockers
2. Dedupe moments by normalized text (lowercase trim) — keep highest importance
3. Cap at maxTakeaways (keep highest importance first)
4. Store each moment via mem.store() with:
   - category matching moment type (blocker → 'open_thread')
   - tags: [session, topic, project, 'trigger:pre-compaction']
   - provenance: { source: 'system' }
5. Build a session snapshot string:
   - "## Session Snapshot\n"
   - "**Decisions:** " + list decision texts (or "none")
   - "**Open threads:** " + list blocker texts (or "none")
   - "**Commitments:** " + list commitment texts (or "none")
   - "**Preferences:** " + list preference texts (or "none")
6. Store the snapshot as category='session_snapshot', importance=0.7, tag 'trigger:pre-compaction'
7. Return { takeaways: number, snapshotId: string, ids: string[] }

Tests (test/runtime-compaction.test.mjs):
1. Turns with 3 decisions + 1 blocker → stores 4 takeaways + 1 snapshot = 5 total
2. Duplicate moments (same text twice) → deduped, stored once
3. More than maxTakeaways moments → capped, highest importance kept
4. No moments in turns → still stores a snapshot (with "none" entries)
5. Snapshot text contains the decision/blocker texts
6. All stored memories tagged with 'trigger:pre-compaction'
7. Returns correct ids and takeaway count
```

---

## Prompt 5 — Wire into index.mjs + integration test

```text
Wire the runtime module into the library's public API.

1. In src/index.mjs, add:
   export { detectKeyMoments, heartbeatStore, extractTopicSlug, contextualRecall, preCompactionDump } from './runtime.mjs';

2. Create test/runtime-integration.test.mjs — an end-to-end test that simulates a full session lifecycle:

   Setup: createMemory({ storage: { type: 'memory' }, embeddings: { type: 'noop' } })

   Test "full session lifecycle":
   a. Seed 5 memories via mem.store() with varying importance (0.3 to 0.9) and categories
   b. Call contextualRecall(mem, 'test-agent', 'deployment pipeline', { maxTokens: 500 })
      - Assert: returns memories, topicSlug is not null, totalTokens <= 500
   c. Simulate 6 conversation turns (mix of user decisions and assistant responses)
   d. Call heartbeatStore(mem, 'test-agent', turns, { sessionId: 'sess-1', minNewTurns: 3 })
      - Assert: stored > 0, lastIndex === 5
   e. Call heartbeatStore again with same lastStoredIndex
      - Assert: skipped (no new turns)
   f. Add 4 more turns including a blocker
   g. Call preCompactionDump(mem, 'test-agent', allTurns, { sessionId: 'sess-1' })
      - Assert: takeaways >= 1 (the blocker), snapshotId exists
   h. Verify memories are searchable:
      const results = await mem.search('test-agent', 'blocker')
      - Assert: finds the blocker memory

3. Run all tests: `npx vitest run` — everything green, including all existing 333 tests.
```

---

## Prompt 6 — README + docs update

```text
Update documentation to cover the new runtime module.

1. In README.md, add a new section "## Runtime Helpers (Agent Integration)" after the existing API sections:

   Briefly describe the three workflows with code examples:
   - heartbeatStore: show a 5-line usage example with turns array
   - contextualRecall: show startup bootstrap example
   - preCompactionDump: show pre-compaction hook example
   - detectKeyMoments: show standalone usage
   - extractTopicSlug: show with synonyms

   Add to the API table:
   | heartbeatStore | Store key moments from conversation turns |
   | contextualRecall | Blended startup recall (recency + semantic + importance) |
   | preCompactionDump | Persist structured takeaways before context loss |
   | detectKeyMoments | Deterministic key-moment detection from text |
   | extractTopicSlug | Extract topic slug with synonym support |

2. In docs/guide.md, add a section "## Agent Runtime Integration" with:
   - Architecture diagram showing host agent → runtime helpers → MemoryGraph
   - Detailed config options for each function
   - Best practices: when to call each helper, recommended config values
   - Integration with OpenClaw (reference docs/PRD-openclaw-neolata-mem-session-memory.md)

3. Update package.json exports if needed (the runtime module should be importable as '@jeremiaheth/neolata-mem').

4. Run all tests to confirm nothing broke.
```

---

## Summary — Build Order

| Step | Module | Tests | Depends on |
|------|--------|-------|------------|
| 1 | `detectKeyMoments` | runtime-detect | — |
| 2 | `heartbeatStore` | runtime-heartbeat | Step 1 |
| 3 | `extractTopicSlug` + `contextualRecall` | runtime-recall | — |
| 4 | `preCompactionDump` | runtime-compaction | Step 1 |
| 5 | Wire into index.mjs + integration test | runtime-integration | Steps 1–4 |
| 6 | README + docs/guide.md | — | Step 5 |

Each prompt is self-contained and testable. No hanging code — every function is tested where it's introduced and wired into the public API in step 5.
