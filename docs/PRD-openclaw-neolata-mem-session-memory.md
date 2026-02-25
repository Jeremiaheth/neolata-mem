# PRD — OpenClaw Session Memory Improvements using neolata-mem
**Version:** 0.1  
**Date:** 2026-02-25  
**Owner:** Jerry (@jeremiaheth.ojo)  
**Status:** Draft (ready to implement)

> **Purpose:** Make OpenClaw’s memory feel *continuous* across sessions by automatically capturing “key moments”, performing contextual recall (not just recency), and persisting a structured “pre-compaction dump” before context is summarized away.

---

## 0. Summary

OpenClaw currently (by your description) relies on:
- a recent-history bootstrap (`--limit 15`) and/or manual `store()` calls
- compaction summaries that can lose nuance

This PRD adds three runtime workflows **owned by the host agent (OpenClaw)** that call into **neolata-mem** as the persistence layer:

1) **Auto-store on key moments**
   - **Inline decision storage** during the conversation
   - **HEARTBEAT idle capture** that writes a session summary before you “go quiet”

2) **Contextual recall, not just recency**
   - Startup recall blends **recency + semantic relevance + importance**
   - Topic-based recall (“OCI” → pull OCI memories) using neolata-mem search/context

3) **Pre-compaction dump**
   - When token budget approaches compaction, store key takeaways as **structured** memories (tags, importance, optional claim)

This PRD is **integration-focused**: neolata-mem does not detect token thresholds or idle timers; OpenClaw does.

---

## 1. Goals and Non-Goals

### Goals
- Reduce “I already told you that” moments by automatically persisting decisions, preferences, and open threads.
- Improve session start quality by retrieving memories **relevant to the current topic**, not only the most recent.
- Prevent compaction from deleting “decision rationale / open loops” by dumping a structured snapshot before summarization.
- Keep memory quality high and safe: avoid poisoning/garbage ingestion and reduce retrieval noise.

### Non-Goals
- Replacing OpenClaw’s context-compaction mechanism.
- Building new storage backends (Supabase, JSON, etc.) beyond neolata-mem.
- Shipping an optimal dynamic-programming knapsack for context packing (keep deterministic greedy packing as default; DP is a future optimization).

---

## 2. Definitions

- **Key moment:** A conversation event that should persist across sessions. Examples:
  - a decision (chosen approach, settled option)
  - a commitment (“I will do X”)
  - a preference (“I prefer aisle seats”)
  - a stable fact (project owner, deadline, environment info)
  - an open thread (blocker, unanswered question, TODO)

- **Idle / quiet:** No user interaction for `idleMs` (configurable). Triggered by OpenClaw’s runtime.

- **Pre-compaction:** The point where OpenClaw is about to compress/summarize conversation context due to token budget. Triggered by OpenClaw’s runtime.

- **Session:** A conversation run with a stable identifier (`sessionId`). OpenClaw supplies it.

---

## 3. Architecture

### 3.1 Components (integration boundaries)

```
OpenClaw Runtime (host/orchestrator)
  ├─ Conversation Loop (messages, tool calls)
  ├─ Token Meter (knows context window usage)
  ├─ Idle Timer / HEARTBEAT scheduler
  ├─ MemoryCapture (this PRD)
  ├─ MemoryRecall (this PRD)
  └─ neolata-mem client (library)
        ├─ store()
        ├─ search()/context()
        ├─ reinforce()/dispute()
        └─ consolidate() (optional cron)
```

**Boundary rule:**  
- **OpenClaw detects triggers** (idle, topic shift, compaction threshold).  
- **neolata-mem stores/retrieves/maintains memories**.

### 3.2 Data flow

**On every turn**
1. Conversation produces messages + tool outputs + “decision signals”
2. `MemoryCapture.onTurn()` decides whether to store
3. If yes: call `mem.store(agentId, text, opts)`

**On startup**
1. OpenClaw gets first user message (or task description)
2. `MemoryRecall.bootstrapContext(seedText)` → returns curated memory context
3. OpenClaw injects that context into the system/developer prompt or “memory” section

**On idle**
1. Idle timer fires
2. `MemoryCapture.onIdle()` creates a session summary + stores it

**Before compaction**
1. Token meter detects threshold (e.g., 80–90% of window)
2. `MemoryCapture.onBeforeCompaction()` stores a structured “session snapshot”

---

## 4. Memory Schema (what we store)

### 4.1 Memory categories
- `decision`
- `preference`
- `fact`
- `open_thread`
- `session_snapshot` (pre-compaction / idle summary)
- `reflection` (optional future)

### 4.2 Tags (recommended)
- `topic:<slug>` (e.g., `topic:oci`, `topic:neolata-mem`)
- `project:<name>`
- `person:<name>`
- `status:open|closed`
- `source:user|tool|system`
- `session:<sessionId>`

### 4.3 Importance scoring (1–10)
Heuristic defaults (no LLM):
- decision: 8–10
- preference: 6–8
- stable fact: 5–8 (depends on impact)
- open_thread: 7–9
- session_snapshot: 7

If you have an LLM available, you can prompt it to rate importance (Generative Agents style) but keep a deterministic fallback.

### 4.4 Claim structure (optional, recommended for facts/decisions)
When possible, store a `claim` to enable contradiction detection and belief updates:
- `subject`: `user|agent|project:<x>`
- `predicate`: `budget_is`, `prefers`, `decision`, `blocker_is`, `deadline_is`
- `value`: normalized string

**Scope guidance**
- `session` for “this time only” (e.g., “window this time”)
- `global` for durable preferences/facts
- `temporal` when it has a validity window

**Session scoping requirement**
If you use `scope:'session'`, store `sessionId` either:
- as a tag (`session:<id>`) OR
- in metadata (preferred if supported)

---

## 5. Feature 1 — Auto-store on key moments

### 5.1 Inline decision storage (during session)

#### Trigger signals (minimal viable)
- The assistant produces a “Decision” section
- The user says “decide”, “let’s do”, “we’ll go with”, “ship”, “agree”
- A task transitions from “considering” → “chosen”
- A TODO is created or closed

#### Storage behavior
- Extract 1–3 compact memories per key moment
- Category = `decision` or `open_thread`
- Tags include topic + project + session
- Add provenance (`user_explicit` if directly stated by user; `tool_output` if from tool; `inference` otherwise)

#### Pseudocode
```ts
async function onDecision(decisionText, ctx) {
  await mem.store(ctx.agentId, decisionText, {
    category: 'decision',
    importance: 9,
    tags: [
      `topic:${ctx.topicSlug}`,
      `project:${ctx.projectSlug}`,
      `session:${ctx.sessionId}`,
      'source:user',
    ],
    provenance: { source: 'user_explicit' },
    // optional:
    claim: {
      subject: `project:${ctx.projectSlug}`,
      predicate: 'decision',
      value: normalizeDecision(decisionText),
      scope: 'global',
    },
  });
}
```

### 5.2 HEARTBEAT idle capture (store session summary before quiet)

#### Trigger
- OpenClaw runs a heartbeat tick every `heartbeatMs` (e.g., 30s)
- If `now - lastUserActivityAt >= idleMs` (e.g., 2–5 min) AND
  - there are “unsaved” changes since last snapshot
  - then dump a session summary

#### Summary format
Store as category `session_snapshot` with:
- What we were doing
- Decisions made
- Open threads / next steps
- Current blockers
- Key references (IDs, links, files) if safe

#### Pseudocode
```ts
async function heartbeatTick(state) {
  if (!state.sessionActive) return;
  const idle = Date.now() - state.lastActivityAt;
  if (idle < state.idleMs) return;
  if (!state.dirtySinceLastSnapshot) return;

  const summary = buildSessionSummary(state.turns); // deterministic or LLM
  await mem.store(state.agentId, summary, {
    category: 'session_snapshot',
    importance: 7,
    tags: [
      `topic:${state.topicSlug}`,
      `project:${state.projectSlug}`,
      `session:${state.sessionId}`,
      'source:system',
    ],
    provenance: { source: 'system' },
  });

  state.dirtySinceLastSnapshot = false;
  state.lastSnapshotAt = Date.now();
}
```

#### Deterministic summary fallback
If you don’t want an LLM call here:
- keep a rolling list of decisions/open_threads captured inline
- heartbeat snapshot just formats those + the last known task state

---

## 6. Feature 2 — Contextual recall (startup)

### 6.1 Startup recall strategy
Replace “recent --limit 15” with a blended recall:

- **Channel A: Recency** — last N memories (e.g., 5)
- **Channel B: Semantic relevance** — search `seedText` (e.g., first user message / task prompt) (e.g., 8)
- **Channel C: Importance** — top importance above threshold (e.g., importance ≥ 8) within last X days (e.g., 10)

Then:
- dedupe by ID
- optionally 1-hop expand via links (if your agent benefits)
- pack into a token budget using **greedy value-density** (score/tokens)

### 6.2 Topic extraction (minimal viable)
- Topic slug = top keyword(s) from seedText (e.g., “OCI” → `oci`)
- Optionally maintain a small synonym map:
  - `oci` → `oracle cloud`, `oracle`, `tenancy`, `compartment`

### 6.3 Pseudocode
```ts
async function bootstrapContext({ agentId, seedText, maxTokens }) {
  const topicSlug = extractTopicSlug(seedText); // e.g. 'oci'

  const recent = await mem.search(agentId, ' ', { limit: 5, rerank: true });
  const relevant = await mem.search(agentId, seedText, { limit: 8, rerank: true });
  const important = await mem.search(agentId, `topic:${topicSlug}`, { limit: 10, rerank: true });

  const merged = dedupeById([...recent, ...relevant, ...important]);

  // Budget pack into a single formatted “memory context” string
  const ctx = formatAndPack(merged, { maxTokens });

  return { topicSlug, ctx, memoryIds: merged.map(m => m.id) };
}
```

> Note: if neolata-mem already provides `context(query, { maxTokens })`, prefer that and feed it a better candidate pool.

### 6.4 Topic shift recall (optional follow-up)
If OpenClaw detects a topic shift mid-session:
- run `mem.search(agentId, newTopicQuery)` and inject a small “Relevant Past Context” block

---

## 7. Feature 3 — Pre-compaction structured dump

### 7.1 Trigger
OpenClaw’s token meter estimates prompt tokens.
When `tokensUsed / window >= compactionThreshold` (e.g., 0.80–0.90):
- before you summarize away older context,
- call `onBeforeCompaction()` to persist structured takeaways.

### 7.2 What to store
Prefer storing **multiple small structured memories** (better retrieval) over one giant blob:

- 1 memory: “Session snapshot” (category `session_snapshot`, importance 7)
- N memories: extracted decisions / blockers / TODOs (category `decision` / `open_thread`, importance 8–10)

### 7.3 Pseudocode
```ts
async function onBeforeCompaction(state) {
  const takeaways = extractTakeaways(state.turns); // deterministic or LLM
  for (const t of takeaways) {
    await mem.store(state.agentId, t.text, {
      category: t.category,
      importance: t.importance,
      tags: [
        `topic:${state.topicSlug}`,
        `project:${state.projectSlug}`,
        `session:${state.sessionId}`,
        ...t.tags,
      ],
      provenance: { source: t.provenanceSource },
      claim: t.claim, // optional
    });
  }

  // Always store a compact snapshot too
  await mem.store(state.agentId, buildSessionSnapshot(takeaways), {
    category: 'session_snapshot',
    importance: 7,
    tags: [
      `topic:${state.topicSlug}`,
      `project:${state.projectSlug}`,
      `session:${state.sessionId}`,
      'source:system',
      'trigger:pre-compaction',
    ],
    provenance: { source: 'system' },
  });
}
```

---

## 8. Safety and Quality (failure modes)

### 8.1 Context drift
Mitigations:
- Prefer decision/fact memories with claims so supersession can happen
- Store recency/validity metadata (event_at / validFrom/validUntil)
- At retrieval: rank by relevance + importance + recency (avoid stale truth)

### 8.2 Contradiction blindness
Mitigations:
- When storing structured facts/decisions, use claim keys
- Use session scope for “this time only” exceptions
- (If v0.8 features exist) trust-gated supersession and `conflicts()` review

### 8.3 Memory poisoning
Mitigations:
- Apply provenance: tool outputs and documents lower trust than explicit user statements
- Quarantine suspicious or low-trust conflicting writes (if supported)
- Do not auto-store raw web content; store only extracted claims/decisions

### 8.4 Retrieval noise
Mitigations:
- Topic tags + query expansion (topic synonym map)
- Dedupe similar results
- Keep snapshot memories short and structured; avoid giant blobs

### 8.5 Unbounded growth
Mitigations:
- Consolidation cron (weekly): dedup, compress clusters, prune superseded/decayed
- Avoid storing duplicates: if same claim repeats, corroborate/reinforce instead of new node

---

## 9. Observability and DX

- Log every memory write with:
  - trigger (`inline_decision|idle_heartbeat|pre_compaction`)
  - memoryId
  - tags
  - importance
  - provenance source

- Log every recall with:
  - query
  - top results + scores
  - total tokens injected

Optional:
- Explainability fields on results (`whyRetrieved`, `whyExcluded`) if using v0.8.1 explainability.

---

## 10. Rollout plan (phased)

### Phase 0 — Instrumentation (0.5–1 day)
- Add sessionId + topicSlug tracking
- Add token meter hooks + idle timer hooks
- Add logging

### Phase 1 — Inline key-moment capture (1–2 days)
- Decision/open-thread detection (heuristic)
- Store structured memories with tags + importance
- Add “manual store” command fallback

### Phase 2 — Startup contextual recall (1 day)
- Implement blended recall (recency + relevance + importance)
- Inject context block at session start
- Track metrics: “memory hits” and user correction rate

### Phase 3 — Pre-compaction dump (1–2 days)
- Add compaction threshold trigger
- Extract takeaways and store structured dump
- Ensure idempotency (don’t dump twice)

### Phase 4 — Weekly maintenance (0.5–1 day)
- Add a scheduled `consolidate()` job (or manual command)
- Prune/merge policy tuned based on memory size

---

## 11. Acceptance criteria

### Auto-store
- Decisions made in-session appear in the next session without manual steps.
- Idle heartbeat produces at most 1 snapshot per idle period.
- No more than ~3 memory writes per “normal” turn unless it’s a decision-heavy segment.

### Contextual recall
- Mentioning a known topic term (e.g., “OCI”) surfaces relevant memories at startup.
- Startup injected context fits within `maxTokens` budget.

### Pre-compaction dump
- Before any compaction, key takeaways are persisted as structured memories.
- After compaction, the agent can still answer “what did we decide?” accurately.

---

## 12. Open questions (optional, if you want to tighten further)
- Where should `sessionId` live: tag vs a first-class field?
- What is the minimum acceptable LLM usage for extraction/importance scoring?
- Do we want automatic “topic shift recall” mid-session in v0.1 or later?

