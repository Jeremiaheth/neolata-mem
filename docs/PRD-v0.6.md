# neolata-mem v0.6.0 — PRD & Implementation Plan

## Product Requirements Document

### Overview

neolata-mem v0.6.0 introduces three research-backed features that bring the library to competitive parity with Graphiti (Zep) and Mem0 while preserving the zero-dependency embedded advantage:

1. **Typed Edges** — Links carry semantic relationship types (not just similarity scores)
2. **SM-2 Spaced Repetition Decay** — Memories that are accessed repeatedly become more resistant to decay, following cognitive science principles
3. **Bi-Temporal Tracking** — Memories distinguish between when an event happened vs when it was recorded

### Research Basis

| Feature | Paper | Key Finding |
|---------|-------|-------------|
| Typed Edges | Zep/Graphiti (arXiv:2501.13956) | Temporal KG with typed relationships: +18.5% accuracy on LongMemEval |
| SM-2 Decay | FOREVER (arXiv:2601.03938) | Ebbinghaus-curve replay schedules improve long-term retention |
| Bi-Temporal | Zep/Graphiti (arXiv:2501.13956) | Separating event time from ingestion time enables temporal reasoning |

### Non-Goals (v0.6.0)

- Episodic memory (v0.7.0)
- Memory compression/summarization (v0.7.0)
- Labeled clustering (v0.7.0)
- MCP server (v0.8.0+)

---

## Current Architecture (Accurate to Source)

### Memory Object Schema (from `graph.mjs` typedef)
```javascript
{
  id: string,           // `mem_${crypto.randomUUID()}`
  agent: string,        // Agent identifier (alphanumeric, hyphens, underscores, dots, spaces)
  memory: string,       // Memory text content
  category: string,     // 'fact' | 'decision' | 'finding' | 'insight' | 'task' | 'event' | 'preference'
  importance: number,   // 0.0–1.0
  tags: string[],       // User-defined keyword tags
  embedding: number[]|null,  // Vector embedding (null for noop provider)
  links: Array<{ id: string, similarity: number }>,  // Bidirectional links
  created_at: string,   // ISO 8601 timestamp
  updated_at: string,   // ISO 8601 timestamp (refreshed on link/reinforce)
  evolution?: Array<{ from: string, to: string, reason: string, at: string }>,
  accessCount?: number, // Incremented by reinforce()
}
```

### Current Decay Formula (from `calcStrength()` in `graph.mjs`)
```javascript
const ageFactor = Math.max(0.1, Math.pow(0.5, ageDays / HALF_LIFE));
const linkBonus = Math.min(0.3, linkCount * 0.05);
const touchFactor = Math.max(0.1, Math.pow(0.5, lastTouchDays / (HALF_LIFE * 2)));
const categoryWeight = { decision: 1.3, preference: 1.4, insight: 1.1 }[category] || 1.0;
const accessBonus = Math.min(0.2, (accessCount || 0) * 0.02);
const strength = Math.min(1.0, (base * ageFactor * touchFactor * categoryWeight) + linkBonus + accessBonus);
```

### File Structure
```
src/
  index.mjs          — createMemory() factory + re-exports
  graph.mjs          — MemoryGraph class (core engine, ~650 lines)
  embeddings.mjs     — openaiEmbeddings(), noopEmbeddings(), cosineSimilarity()
  storage.mjs        — jsonStorage(), memoryStorage()
  supabase-storage.mjs — supabaseStorage() with incremental ops
  extraction.mjs     — llmExtraction(), passthroughExtraction()
  llm.mjs            — openaiChat(), openclawChat()
  validate.mjs       — validateBaseUrl()
  writethrough.mjs   — markdownWritethrough(), webhookWritethrough()
test/
  graph.test.mjs     — Core graph tests (uses fakeEmbeddings, memoryStorage)
  batch-and-keywords.test.mjs
  events.test.mjs
  security.test.mjs
  storage-contract.test.mjs
  + 7 more test files (144 tests total across 11 files)
```

### Key Patterns in Existing Code
- **Test helper `fakeEmbeddings()`**: Hash-based deterministic embeddings (64-dim vectors)
- **Test helper `createTestGraph()`**: `new MemoryGraph({ storage: memoryStorage(), embeddings: fakeEmbeddings(), ... })`
- **Index system**: `_idIndex` (Map<id, Memory>), `_tokenIndex` (Map<token, Set<id>>)
- **Incremental storage**: If `storage.incremental === true`, uses `upsert()/remove()` instead of full `save()`
- **Event system**: `graph.on('store'|'search'|'decay'|'link', handler)`
- **Supabase field mapping**: Internal `agent` ↔ DB `agent_id`, internal `memory` ↔ DB `content`

---

## Feature Specifications

### Feature 1: Typed Edges

**Current State:**
```javascript
mem.links = [{ id: 'abc', similarity: 0.87 }]
```

**Target State:**
```javascript
mem.links = [{ id: 'abc', similarity: 0.87, type: 'similar' }]
```

**Link Types:**
| Type | Source | Description |
|------|--------|-------------|
| `similar` | Auto (store) | Default. Created by A-MEM cosine threshold |
| `supersedes` | Auto (evolve) | New memory replaced old one via conflict resolution |
| `contradicts` | Auto (detectConflicts) | New fact contradicts existing |
| `supports` | Auto (detectConflicts) | New fact corroborates existing |
| `caused_by` | User | Causal relationship |
| `part_of` | User | Hierarchical containment |
| `related` | User | Generic user-defined relationship |

**API Changes:**
```javascript
// store() — no API change, auto-links get type: 'similar'
await mem.store('agent', 'text');

// evolve() — archived memories get link type: 'supersedes'
await mem.evolve('agent', 'updated text');

// links() — returns type field
await mem.links(id);
// → { ..., links: [{ id, similarity, type: 'similar', memory, agent, category }] }

// traverse() — optional type filter
await mem.traverse(startId, 2, { types: ['similar', 'supersedes'] });

// path() — optional type filter
await mem.path(idA, idB, { types: ['similar'] });

// New: manual link creation
await mem.link(sourceId, targetId, { type: 'caused_by', similarity: null });
await mem.unlink(sourceId, targetId);
```

**Storage Impact:**
- JSON: Links array elements gain `type` field. Old links without `type` default to `'similar'` on read.
- Supabase: `memory_links` table gains `link_type TEXT DEFAULT 'similar'` column. Migration: `ALTER TABLE memory_links ADD COLUMN link_type TEXT DEFAULT 'similar';`
- In-memory: Same as JSON.

**Backward Compatibility:**
- Links without `type` field treated as `'similar'` everywhere (read-time default).
- No migration required for JSON storage — works transparently.
- Supabase migration is additive (new column with default).

---

### Feature 2: SM-2 Spaced Repetition Decay

**Current State (from `calcStrength()`):**
- `accessBonus = min(0.2, accessCount * 0.02)` — linear, maxes out at 10 accesses
- `ageFactor = 0.5^(ageDays / halfLife)` — flat exponential, ignores access pattern
- `touchFactor = 0.5^(lastTouchDays / (halfLife * 2))` — recency from `updated_at`

**Problem:** A memory accessed 10 times in quick succession gets the same bonus as one accessed 10 times over 6 months. The spacing pattern doesn't matter.

**Target State:**
New fields on Memory:
```javascript
{
  ...existing,
  stability: number,        // SM-2 stability factor (grows with spaced access)
  lastReviewInterval: number, // Days since previous review at time of last review
}
```

New `calcStrength()` formula:
```javascript
// SM-2-inspired retrievability
const stability = mem.stability ?? 1.0;
const daysSinceTouch = lastTouchDays;
const retrievability = Math.exp(-0.5 * daysSinceTouch / stability);

// Combined strength
const strength = Math.min(1.0,
  (base * retrievability * categoryWeight) + linkBonus
);
```

New `reinforce()` behavior:
```javascript
// On reinforce:
const currentInterval = daysSinceLastTouch;
const previousInterval = mem.lastReviewInterval || 1;
// Spacing bonus: longer intervals between reviews = more stability gain
const spacingFactor = Math.min(3.0, currentInterval / Math.max(1, previousInterval));
// SM-2 growth: stability multiplied by growth factor
const growthRate = opts.graph?.stabilityGrowth ?? 2.0;
mem.stability = (mem.stability ?? 1.0) * (1.0 + (growthRate - 1.0) * spacingFactor / 3.0);
mem.lastReviewInterval = currentInterval;
```

**Config Changes:**
```javascript
config: {
  ...existing,
  // DEPRECATED (still read for backward compat, used as fallback)
  decayHalfLifeDays: 30,
  // NEW
  initialStability: 1.0,    // Starting stability for new memories
  stabilityGrowth: 2.0,     // Max growth rate per reinforcement
}
```

**Backward Compatibility:**
- Memories without `stability` field: `calcStrength()` uses fallback formula (current behavior) with `stability = initialStability`.
- `decayHalfLifeDays` still respected as a scaling parameter.
- `reinforce()` starts writing `stability` and `lastReviewInterval` on first call — progressive migration.

---

### Feature 3: Bi-Temporal Tracking

**Current State:**
- `created_at`: Set to `new Date().toISOString()` at store time
- `updated_at`: Refreshed on link, reinforce, evolve

**Problem:** "The server was migrated to AWS on Jan 15" stored on Feb 24 → `created_at` is Feb 24. No way to query "what happened in January?"

**Target State:**
New optional field:
```javascript
{
  ...existing,
  event_at: string | null,  // ISO 8601 — when the event happened (null = same as created_at)
}
```

**API Changes:**
```javascript
// store() — optional eventTime
await mem.store('agent', 'Server migrated to AWS', { eventTime: '2026-01-15T00:00:00Z' });

// storeMany() — per-item eventTime
await mem.storeMany('agent', [
  { text: 'Server migrated', eventTime: '2026-01-15' },
  { text: 'DNS updated', eventTime: '2026-01-16' },
]);

// timeline() — can filter by event time
await mem.timeline('agent', 7);  // Default: uses event_at if present, else created_at
await mem.timeline('agent', 7, { timeField: 'event' });  // Only event_at
await mem.timeline('agent', 7, { timeField: 'created' }); // Only created_at (current behavior)

// search() — optional temporal filter
await mem.search('agent', 'migration', { before: '2026-02-01', after: '2026-01-01' });
```

**Storage Impact:**
- JSON: New optional `event_at` field. Absent = null.
- Supabase: `ALTER TABLE memories ADD COLUMN event_at TIMESTAMPTZ;`
- Field mapping: internal `event_at` ↔ DB `event_at`

**Backward Compatibility:**
- `event_at` is optional. All existing memories have `event_at: undefined/null`.
- `timeline()` without options uses `event_at ?? created_at` — same behavior for old memories.

---

## Implementation Chunks

### Phase 1: Typed Edges (v0.6.0-alpha.1)

| Step | What | Tests | Risk |
|------|------|-------|------|
| 1.1 | Add `type` field to link creation in `store()` | Unit: store creates links with `type: 'similar'` | Low — additive field |
| 1.2 | Default missing `type` to `'similar'` in all link readers (`links()`, `traverse()`, `path()`, `clusters()`, `orphans()`, `health()`) | Unit: old-format links handled correctly | Low — read-time default |
| 1.3 | Add type to evolve() — `supersedes` links from archived→new | Unit: evolve creates supersedes link | Low — additive |
| 1.4 | Add type filter to `traverse()` and `path()` | Unit: filter works, unfiltered returns all | Low |
| 1.5 | Add `link()` and `unlink()` manual methods | Unit: create/remove custom links, validation | Medium — new API surface |
| 1.6 | Update Supabase storage: `link_type` column in upsertLinks, loadLinks, save | Integration: round-trip typed links through Supabase mock | Medium — schema change |
| 1.7 | Update writethrough + events to include link type | Unit: events carry type | Low |

### Phase 2: SM-2 Decay (v0.6.0-alpha.2)

| Step | What | Tests | Risk |
|------|------|-------|------|
| 2.1 | Add `stability` and `lastReviewInterval` fields to `reinforce()` | Unit: reinforce writes new fields | Low — additive fields |
| 2.2 | Update `calcStrength()` to use SM-2 retrievability when stability present | Unit: new formula matches expected values; old memories use fallback | Medium — formula change |
| 2.3 | Add config options `initialStability`, `stabilityGrowth` | Unit: config defaults, override | Low |
| 2.4 | Update `decay()` to work with new strength formula | Unit: decay thresholds still apply correctly | Low — uses calcStrength() |
| 2.5 | Add spacing bonus logic to `reinforce()` | Unit: rapid reinforcement < spaced reinforcement in stability gain | Medium — core behavior change |
| 2.6 | Update Supabase `toRow`/`fromRow` for new fields | Integration: round-trip stability through Supabase mock | Low |
| 2.7 | Update `health()` report to include stability stats | Unit: health includes avg stability | Low |

### Phase 3: Bi-Temporal (v0.6.0-alpha.3)

| Step | What | Tests | Risk |
|------|------|-------|------|
| 3.1 | Add `eventTime` option to `store()` → writes `event_at` | Unit: stored memory has event_at | Low |
| 3.2 | Add `eventTime` option to `storeMany()` | Unit: batch stores with event_at | Low |
| 3.3 | Update `timeline()` to use `event_at ?? created_at` by default | Unit: timeline sorts by event time | Low |
| 3.4 | Add `before`/`after` temporal filter to `search()` | Unit: temporal filter works | Medium — search path change |
| 3.5 | Update Supabase `toRow`/`fromRow` for `event_at` | Integration: round-trip event_at | Low |
| 3.6 | Update `context()` to pass temporal filters through | Unit: context respects before/after | Low |

### Phase 4: Integration & Polish (v0.6.0-rc.1)

| Step | What | Tests | Risk |
|------|------|-------|------|
| 4.1 | Wire `createMemory()` factory to accept new config options | Unit: factory passes through | Low |
| 4.2 | End-to-end test: store → evolve → typed links → search with temporal filter → decay with SM-2 | Integration | Medium |
| 4.3 | Update existing tests for backward compat (links without type, memories without stability) | Regression | Low |
| 4.4 | Update README + docs | — | — |

---

## Micro-Steps (Final Breakdown)

### Phase 1: Typed Edges

**Step 1.1**: Add `type: 'similar'` to link objects in `store()`
- Edit: `store()` in graph.mjs — `topLinks.map(l => ({ id: l.id, similarity: l.similarity }))` → add `type: 'similar'`
- Edit: backlink push — add `type: 'similar'`
- Test: Store 2 similar memories, verify `links[0].type === 'similar'`

**Step 1.2**: Default `type` on read in link consumers
- Edit: `links()`, `traverse()`, `path()`, `clusters()`, `orphans()` — when reading `mem.links`, use `link.type || 'similar'`
- Test: Create graph with old-format links (no type), verify all readers return `type: 'similar'`

**Step 1.3**: Typed links in `evolve()`
- Edit: `evolve()` archive section — when archiving conflicting memory, add a link from new memory to archived ID with `type: 'supersedes'`
- Test: Evolve conflicting memory, verify supersedes link exists

**Step 1.4**: Type filter for `traverse()` and `path()`
- Edit: `traverse()` — accept optional `opts.types` array, skip links not matching
- Edit: `path()` — accept optional `opts.types` array, skip links not matching
- Test: Graph with mixed types, traverse with filter returns only matching paths

**Step 1.5**: Manual `link()` and `unlink()` methods
- Add: `graph.link(sourceId, targetId, { type, similarity })` — validates IDs exist, creates bidirectional link
- Add: `graph.unlink(sourceId, targetId)` — removes link from both sides
- Test: Create link, verify bidirectional. Unlink, verify removed. Invalid IDs throw.

**Step 1.6**: Supabase typed links
- Edit: `supabase-storage.mjs` — `upsertLinks()` writes `link_type`, `loadLinks()` reads it
- Edit: `save()` link reconciliation — include `link_type`
- Test: Mock Supabase round-trip with typed links

**Step 1.7**: Events + writethrough
- Edit: `emit('link', ...)` in `store()` — add `type` field
- Test: Event listener receives type

### Phase 2: SM-2 Decay

**Step 2.1**: New fields in `reinforce()`
- Edit: `reinforce()` — write `mem.stability`, `mem.lastReviewInterval` (calculate from current `updated_at`)
- Test: Reinforce memory, verify new fields set

**Step 2.2**: SM-2 formula in `calcStrength()`
- Edit: `calcStrength()` — if `mem.stability` exists, use retrievability formula; else use current formula
- Test: Memory with stability=5.0 and 10 days old → specific expected strength. Memory without stability → same as current.

**Step 2.3**: Config options
- Edit: constructor — add `initialStability` (default 1.0), `stabilityGrowth` (default 2.0)
- Test: Override in constructor, verify stored in config

**Step 2.4**: Decay with new formula
- Test: Create memories with varying stability, run decay(), verify correct archive/delete decisions

**Step 2.5**: Spacing bonus in `reinforce()`
- Edit: `reinforce()` — stability growth scales with spacing factor
- Test: Reinforce 3x rapidly → lower stability than reinforce 3x with increasing intervals

**Step 2.6**: Supabase fields
- Edit: `toRow()` — map `stability`, `lastReviewInterval`
- Edit: `fromRow()` — read them back
- Test: Round-trip through Supabase mock

**Step 2.7**: Health report
- Edit: `health()` — add `avgStability`, stability distribution
- Test: Health report includes new fields

### Phase 3: Bi-Temporal

**Step 3.1**: `eventTime` in `store()`
- Edit: `store()` — accept `opts.eventTime`, validate ISO 8601, store as `event_at`
- Test: Store with eventTime, verify `event_at` set. Store without, verify `event_at` undefined.

**Step 3.2**: `eventTime` in `storeMany()`
- Edit: `storeMany()` — per-item `eventTime`
- Test: Batch store with mixed eventTimes

**Step 3.3**: Timeline uses `event_at`
- Edit: `timeline()` — use `mem.event_at || mem.created_at` for date grouping
- Accept optional `timeField` param
- Test: Memories with event_at in the past appear in correct date bucket

**Step 3.4**: Temporal filter in `search()`
- Edit: `search()` — accept `opts.before`, `opts.after` (ISO strings), filter candidates by `event_at || created_at`
- Test: Search with before/after returns correct subset

**Step 3.5**: Supabase event_at
- Edit: `toRow()`, `fromRow()` — map `event_at`
- Test: Round-trip

**Step 3.6**: Context temporal passthrough
- Edit: `context()` — accept and pass `before`/`after` to `search()`
- Test: Context respects temporal filters

### Phase 4: Integration

**Step 4.1**: Factory wiring
- Edit: `createMemory()` in `index.mjs` — pass `initialStability`, `stabilityGrowth` through to config
- Test: `createMemory({ graph: { stabilityGrowth: 3.0 } })` → graph.config.stabilityGrowth === 3.0

**Step 4.2**: End-to-end integration test
- New test file: `test/v060-integration.test.mjs`
- Test full workflow: store with eventTime → search with temporal filter → evolve → verify supersedes link → reinforce → verify stability → decay

**Step 4.3**: Backward compat regression
- Run all 144 existing tests unchanged
- Add explicit test: old-format memories (no type, no stability, no event_at) load and work correctly

**Step 4.4**: Docs
- Update README with new features
- Add migration guide

---

## Codex Prompts

Each prompt below is self-contained with full context. They must be executed in order — each builds on the previous.

---

### Prompt 1: Typed Edges — Link Type in `store()` and Backlinks

```text
You are working on the neolata-mem project, a graph-native memory engine for AI agents.

## Project Structure
- src/graph.mjs — MemoryGraph class (core engine)
- src/storage.mjs — jsonStorage(), memoryStorage()
- src/embeddings.mjs — openaiEmbeddings(), noopEmbeddings(), cosineSimilarity()
- test/graph.test.mjs — Core tests using vitest, memoryStorage(), fakeEmbeddings()
- All tests run with: `npx vitest run`

## Current Link Format
In graph.mjs, the `store()` method creates links like:
```js
topLinks.map(l => ({ id: l.id, similarity: l.similarity }))
```
And backlinks:
```js
target.links.push({ id, similarity: link.similarity });
```

## Task
Add a `type` field to all link objects. For now, all auto-created links get `type: 'similar'`.

### Changes to make in `src/graph.mjs`:

1. In `store()`, change the link mapping (around the line `links: topLinks.map(...)`) to include `type: 'similar'`:
   ```js
   links: topLinks.map(l => ({ id: l.id, similarity: l.similarity, type: 'similar' })),
   ```

2. In `store()`, where backlinks are pushed to target memories, add `type: 'similar'`:
   ```js
   target.links.push({ id, similarity: link.similarity, type: 'similar' });
   ```

3. In `storeMany()`, same two changes — the link mapping and backlink push should include `type: 'similar'`.

4. Update the JSDoc typedef at the top of graph.mjs. Change:
   ```js
   links: {id: string, similarity: number}[]
   ```
   To:
   ```js
   links: {id: string, similarity: number, type?: string}[]
   ```

### Changes to make in `test/graph.test.mjs`:

Add a new test in the `store` describe block:

```js
it('should create links with type "similar"', async () => {
  const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
  await graph.store('agent-1', 'The user prefers dark mode');
  const r2 = await graph.store('agent-1', 'The user likes dark theme in VS Code');
  
  const mem = graph.memories.find(m => m.id === r2.id);
  for (const link of mem.links) {
    expect(link.type).toBe('similar');
  }
  
  // Verify backlinks also have type
  const first = graph.memories[0];
  for (const link of first.links) {
    expect(link.type).toBe('similar');
  }
});
```

### Verification
After making changes, run `npx vitest run` and ensure:
1. All existing tests still pass (backward compat)
2. The new test passes
3. No other files need changes for this step
```

---

### Prompt 2: Typed Edges — Read-Time Default for Old Links

```text
You are continuing work on neolata-mem. In the previous step, we added `type: 'similar'` to all new links created by `store()` and `storeMany()`.

## Problem
Existing memories stored before this change have links without a `type` field. All link-reading methods must handle this gracefully by defaulting missing `type` to `'similar'`.

## Task
Add read-time defaulting in every method that reads link objects from memories.

### Changes to `src/graph.mjs`:

1. **`links()` method** — where it maps over `mem.links`, add type default:
   Change:
   ```js
   const linked = (mem.links || []).map(link => {
     const target = this._byId(link.id);
     return {
       id: link.id,
       similarity: link.similarity,
       memory: target?.memory || '(deleted)',
       agent: target?.agent || '?',
       category: target?.category || '?',
     };
   });
   ```
   To:
   ```js
   const linked = (mem.links || []).map(link => {
     const target = this._byId(link.id);
     return {
       id: link.id,
       similarity: link.similarity,
       type: link.type || 'similar',
       memory: target?.memory || '(deleted)',
       agent: target?.agent || '?',
       category: target?.category || '?',
     };
   });
   ```

2. **`traverse()` method** — in the visited.set() call, include type in the link info. No change needed if we only track nodes. But when iterating links to push to queue, no structural change needed — type is on the link object, we just pass it through. Actually, traverse doesn't expose link info per-hop currently. Skip for now.

3. **No changes needed** for `clusters()`, `orphans()`, `path()`, `health()` — they don't expose individual link objects to the caller. They count links or traverse the graph. The `type` field is preserved on the memory objects in-memory already.

### Changes to `test/graph.test.mjs`:

Add a test that verifies old-format links work:

```js
it('should default link type to "similar" for old-format links', async () => {
  const graph = createTestGraph();
  // Manually inject an old-format memory with links missing type
  graph.memories.push({
    id: 'mem_old-1', agent: 'a', memory: 'old memory', category: 'fact',
    importance: 0.7, tags: [], embedding: null,
    links: [{ id: 'mem_old-2', similarity: 0.8 }],  // no type field
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  graph.memories.push({
    id: 'mem_old-2', agent: 'a', memory: 'another old memory', category: 'fact',
    importance: 0.7, tags: [], embedding: null,
    links: [{ id: 'mem_old-1', similarity: 0.8 }],  // no type field
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  graph._rebuildIndexes();

  const result = await graph.links('mem_old-1');
  expect(result.links[0].type).toBe('similar');
});
```

### Verification
Run `npx vitest run`. All tests pass. The links() method now always returns a `type` field.
```

---

### Prompt 3: Typed Edges — `supersedes` Links in `evolve()`

```text
You are continuing work on neolata-mem. Links now have a `type` field (default 'similar'). 

## Task
When `evolve()` archives a conflicting memory, create a `supersedes` link from the NEW memory to the OLD (archived) memory's ID. This creates a lineage chain.

## Current evolve() behavior (in graph.mjs):
1. Calls `detectConflicts()` to find conflicts/updates
2. For conflicts: archives old memory, removes from graph
3. For updates: modifies existing in-place
4. For novel: calls `store()` normally

## Changes to `src/graph.mjs`:

In the `evolve()` method, after archiving conflicting memories and before storing the new memory, collect the archived IDs. Then after `store()` returns, add supersedes links.

Find this section in `evolve()`:
```js
// Archive conflicting memories
for (const conflict of (conflicts.conflicts || [])) {
  if (conflict.memoryId) {
    const old = this._byId(conflict.memoryId);
    if (old) {
      ...archives and removes...
      actions.push({ type: 'archived', id: conflict.memoryId, reason: conflict.reason, old: old.memory });
    }
  }
}
```

After this loop, add tracking of archived IDs:
```js
const archivedIds = actions.filter(a => a.type === 'archived').map(a => a.id);
```

Then find where the novel store happens:
```js
// Novel: store with A-MEM linking
const result = await this.store(agent, text, { category, importance, tags });
```

After this line, add supersedes links:
```js
// Add supersedes links to archived memories
if (archivedIds.length > 0) {
  const newMem = this._byId(result.id);
  if (newMem) {
    for (const archivedId of archivedIds) {
      if (!newMem.links.find(l => l.id === archivedId)) {
        newMem.links.push({ id: archivedId, similarity: 1.0, type: 'supersedes' });
      }
    }
    if (this.storage.incremental) {
      await this.storage.upsert(newMem);
    } else {
      await this.save();
    }
  }
}
```

Also, in the `evolve()` updates section, when a memory is evolved in-place, record the evolution with a typed approach. Find:
```js
existing.evolution = existing.evolution || [];
existing.evolution.push({ from: oldContent, to: text, reason: update.reason, at: new Date().toISOString() });
```
No link change needed here — in-place updates don't create new memories.

### Tests — add to `test/graph.test.mjs`:

This test needs an LLM mock. Add a mock LLM helper:

```js
function mockLLM(response) {
  return {
    name: 'mock-llm',
    async chat() { return JSON.stringify(response); },
  };
}
```

Then add the test:

```js
describe('evolve', () => {
  it('should create supersedes links when archiving conflicts', async () => {
    const graph = createTestGraph({
      config: { linkThreshold: 0.1 },
      llm: mockLLM({
        conflicts: [{ index: 0, reason: 'outdated' }],
        updates: [],
        novel: true,
      }),
    });
    
    // Store original
    const original = await graph.store('agent-1', 'Server runs on port 3000');
    
    // Evolve with conflicting info
    const result = await graph.evolve('agent-1', 'Server now runs on port 8080');
    
    expect(result.actions.some(a => a.type === 'archived')).toBe(true);
    expect(result.stored).toBe(true);
    
    // The new memory should have a supersedes link to the archived one
    const newMem = graph.memories.find(m => m.id === result.id);
    if (newMem) {
      const supersedesLink = newMem.links.find(l => l.type === 'supersedes');
      expect(supersedesLink).toBeDefined();
      expect(supersedesLink.id).toBe(original.id);
    }
  });
});
```

### Verification
Run `npx vitest run`. All tests pass including the new evolve test.
```

---

### Prompt 4: Typed Edges — Type Filter for `traverse()` and `path()`

```text
You are continuing work on neolata-mem. Links now have `type` fields ('similar', 'supersedes', etc.).

## Task
Add optional type filtering to `traverse()` and `path()` so callers can traverse only specific relationship types.

### Changes to `src/graph.mjs`:

1. **`traverse()` method** — currently signature is:
   ```js
   async traverse(startId, maxHops = 2)
   ```
   
   Change to:
   ```js
   async traverse(startId, maxHops = 2, { types } = {})
   ```
   
   In the inner loop where links are iterated:
   ```js
   if (hop < maxHops) {
     for (const link of (mem.links || [])) {
       if (!visited.has(link.id)) {
         queue.push({ id: link.id, hop: hop + 1, similarity: link.similarity });
       }
     }
   }
   ```
   
   Change to:
   ```js
   if (hop < maxHops) {
     for (const link of (mem.links || [])) {
       if (visited.has(link.id)) continue;
       const linkType = link.type || 'similar';
       if (types && !types.includes(linkType)) continue;
       queue.push({ id: link.id, hop: hop + 1, similarity: link.similarity });
     }
   }
   ```

2. **`path()` method** — currently signature is:
   ```js
   async path(idA, idB)
   ```
   
   Change to:
   ```js
   async path(idA, idB, { types } = {})
   ```
   
   In the inner loop:
   ```js
   for (const link of (mem.links || [])) {
     if (!visited.has(link.id)) {
       visited.set(link.id, id);
       queue.push(link.id);
     }
   }
   ```
   
   Change to:
   ```js
   for (const link of (mem.links || [])) {
     if (visited.has(link.id)) continue;
     const linkType = link.type || 'similar';
     if (types && !types.includes(linkType)) continue;
     visited.set(link.id, id);
     queue.push(link.id);
   }
   ```

### Tests — add to `test/graph.test.mjs`:

```js
describe('traverse with type filter', () => {
  it('should only follow links of specified types', async () => {
    const graph = createTestGraph();
    // Manually build a small typed graph
    const now = new Date().toISOString();
    const mems = [
      { id: 'mem_a', agent: 'a', memory: 'mem a', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_b', similarity: 0.9, type: 'similar' }, { id: 'mem_c', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
      { id: 'mem_b', agent: 'a', memory: 'mem b', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_a', similarity: 0.9, type: 'similar' }], created_at: now, updated_at: now },
      { id: 'mem_c', agent: 'a', memory: 'mem c', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_a', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
    ];
    graph.memories = mems;
    graph.loaded = true;
    graph._rebuildIndexes();
    
    // Traverse only 'similar' links — should reach a and b, but not c
    const result = await graph.traverse('mem_a', 2, { types: ['similar'] });
    const ids = result.nodes.map(n => n.id);
    expect(ids).toContain('mem_a');
    expect(ids).toContain('mem_b');
    expect(ids).not.toContain('mem_c');
    
    // Traverse all types — should reach all 3
    const all = await graph.traverse('mem_a', 2);
    expect(all.nodes.length).toBe(3);
  });
});

describe('path with type filter', () => {
  it('should only use links of specified types', async () => {
    const graph = createTestGraph();
    const now = new Date().toISOString();
    graph.memories = [
      { id: 'mem_x', agent: 'a', memory: 'x', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_y', similarity: 0.9, type: 'similar' }, { id: 'mem_z', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
      { id: 'mem_y', agent: 'a', memory: 'y', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_x', similarity: 0.9, type: 'similar' }], created_at: now, updated_at: now },
      { id: 'mem_z', agent: 'a', memory: 'z', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_x', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
    ];
    graph.loaded = true;
    graph._rebuildIndexes();
    
    // Path from x to z via 'similar' only — should not find it
    const noPath = await graph.path('mem_x', 'mem_z', { types: ['similar'] });
    expect(noPath.found).toBe(false);
    
    // Path from x to z via 'supersedes' — should find it
    const found = await graph.path('mem_x', 'mem_z', { types: ['supersedes'] });
    expect(found.found).toBe(true);
    expect(found.hops).toBe(1);
  });
});
```

### Verification
Run `npx vitest run`. All tests pass.
```

---

### Prompt 5: Typed Edges — Manual `link()` and `unlink()` Methods

```text
You are continuing work on neolata-mem. Links now have types and can be filtered.

## Task
Add `link()` and `unlink()` methods to MemoryGraph for manual link management.

### Changes to `src/graph.mjs`:

Add these two methods in the LINKS section (after the `links()` method, before `traverse()`):

```js
/**
 * Manually create a bidirectional link between two memories.
 * @param {string} sourceId
 * @param {string} targetId
 * @param {object} [opts]
 * @param {string} [opts.type='related'] - Link type
 * @param {number|null} [opts.similarity=null] - Similarity score (null for non-semantic links)
 * @returns {Promise<{sourceId: string, targetId: string, type: string}>}
 */
async link(sourceId, targetId, { type = 'related', similarity = null } = {}) {
  await this.init();
  if (sourceId === targetId) throw new Error('Cannot link a memory to itself');
  const source = this._byId(sourceId);
  const target = this._byId(targetId);
  if (!source) throw new Error(`Memory not found: ${sourceId}`);
  if (!target) throw new Error(`Memory not found: ${targetId}`);

  // Validate type
  if (typeof type !== 'string' || type.length === 0 || type.length > 50) {
    throw new Error('Link type must be a non-empty string (max 50 chars)');
  }

  const now = new Date().toISOString();

  // Add forward link (or update if exists)
  const existingForward = source.links.findIndex(l => l.id === targetId);
  if (existingForward >= 0) {
    source.links[existingForward] = { id: targetId, similarity, type };
  } else {
    source.links.push({ id: targetId, similarity, type });
  }
  source.updated_at = now;

  // Add reverse link (or update if exists)
  const existingReverse = target.links.findIndex(l => l.id === sourceId);
  if (existingReverse >= 0) {
    target.links[existingReverse] = { id: sourceId, similarity, type };
  } else {
    target.links.push({ id: sourceId, similarity, type });
  }
  target.updated_at = now;

  if (this.storage.incremental) {
    await this.storage.upsert(source);
    await this.storage.upsert(target);
  } else {
    await this.save();
  }

  this.emit('link', { sourceId, targetId, type, similarity });
  return { sourceId, targetId, type };
}

/**
 * Remove a bidirectional link between two memories.
 * @param {string} sourceId
 * @param {string} targetId
 * @returns {Promise<{removed: boolean}>}
 */
async unlink(sourceId, targetId) {
  await this.init();
  const source = this._byId(sourceId);
  const target = this._byId(targetId);

  let removed = false;
  const now = new Date().toISOString();

  if (source) {
    const before = source.links.length;
    source.links = source.links.filter(l => l.id !== targetId);
    if (source.links.length < before) { removed = true; source.updated_at = now; }
  }

  if (target) {
    const before = target.links.length;
    target.links = target.links.filter(l => l.id !== sourceId);
    if (target.links.length < before) { removed = true; target.updated_at = now; }
  }

  if (removed) {
    if (this.storage.incremental) {
      if (source) await this.storage.upsert(source);
      if (target) await this.storage.upsert(target);
    } else {
      await this.save();
    }
  }

  return { removed };
}
```

### Tests — add to `test/graph.test.mjs`:

```js
describe('link and unlink', () => {
  it('should create a manual bidirectional link', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Memory one');
    const r2 = await graph.store('a', 'Memory two');
    
    const result = await graph.link(r1.id, r2.id, { type: 'caused_by' });
    expect(result.type).toBe('caused_by');
    
    const links1 = await graph.links(r1.id);
    const links2 = await graph.links(r2.id);
    expect(links1.links.some(l => l.id === r2.id && l.type === 'caused_by')).toBe(true);
    expect(links2.links.some(l => l.id === r1.id && l.type === 'caused_by')).toBe(true);
  });

  it('should reject self-links', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Memory one');
    await expect(graph.link(r1.id, r1.id)).rejects.toThrow('Cannot link a memory to itself');
  });

  it('should reject invalid memory IDs', async () => {
    const graph = createTestGraph();
    await expect(graph.link('fake-1', 'fake-2')).rejects.toThrow('Memory not found');
  });

  it('should update existing link type on re-link', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Memory one');
    const r2 = await graph.store('a', 'Memory two');
    
    await graph.link(r1.id, r2.id, { type: 'related' });
    await graph.link(r1.id, r2.id, { type: 'caused_by' });
    
    const links1 = await graph.links(r1.id);
    const causedBy = links1.links.filter(l => l.id === r2.id);
    expect(causedBy.length).toBe(1);
    expect(causedBy[0].type).toBe('caused_by');
  });

  it('should unlink memories', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Memory one');
    const r2 = await graph.store('a', 'Memory two');
    
    await graph.link(r1.id, r2.id, { type: 'related' });
    const result = await graph.unlink(r1.id, r2.id);
    expect(result.removed).toBe(true);
    
    const links1 = await graph.links(r1.id);
    expect(links1.links.some(l => l.id === r2.id)).toBe(false);
  });

  it('should return removed:false for non-existent link', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Memory one');
    const r2 = await graph.store('a', 'Memory two');
    const result = await graph.unlink(r1.id, r2.id);
    expect(result.removed).toBe(false);
  });
});
```

### Verification
Run `npx vitest run`. All tests pass.
```

---

### Prompt 6: Typed Edges — Supabase Storage Update

```text
You are continuing work on neolata-mem. Links now have a `type` field.

## Task
Update supabase-storage.mjs to persist and read link types.

### Changes to `src/supabase-storage.mjs`:

1. In `loadLinks()`, the SELECT and mapping needs to include `link_type`:

   Change the query:
   ```js
   `/rest/v1/${linksTable}?select=source_id,target_id,strength&limit=1000&offset=${offset}`
   ```
   To:
   ```js
   `/rest/v1/${linksTable}?select=source_id,target_id,strength,link_type&limit=1000&offset=${offset}`
   ```

   Change the link mapping:
   ```js
   linkMap.get(l.source_id).push({ id: l.target_id, similarity: l.strength });
   ...
   linkMap.get(l.target_id).push({ id: l.source_id, similarity: l.strength });
   ```
   To:
   ```js
   linkMap.get(l.source_id).push({ id: l.target_id, similarity: l.strength, type: l.link_type || 'similar' });
   ...
   linkMap.get(l.target_id).push({ id: l.source_id, similarity: l.strength, type: l.link_type || 'similar' });
   ```

2. In `save()`, where link rows are built:
   Change:
   ```js
   linkRows.push({
     id: randomUUID(),
     source_id: mem.id,
     target_id: link.id,
     strength: link.similarity,
     created_at: mem.created_at,
   });
   ```
   To:
   ```js
   linkRows.push({
     id: randomUUID(),
     source_id: mem.id,
     target_id: link.id,
     strength: link.similarity,
     link_type: link.type || 'similar',
     created_at: mem.created_at,
   });
   ```

3. In `upsertLinks()`, same change:
   Change:
   ```js
   const rows = links.map(l => ({
     id: randomUUID(),
     source_id: sourceId,
     target_id: l.id,
     strength: l.similarity,
     created_at: new Date().toISOString(),
   }));
   ```
   To:
   ```js
   const rows = links.map(l => ({
     id: randomUUID(),
     source_id: sourceId,
     target_id: l.id,
     strength: l.similarity,
     link_type: l.type || 'similar',
     created_at: new Date().toISOString(),
   }));
   ```

### Changes to `test/mock-supabase.mjs` (if it exists) or relevant Supabase test:

The mock needs to store and return `link_type`. Check the existing mock and ensure link rows include `link_type`.

### Changes to `test/supabase-graph.test.mjs` (or appropriate test file):

Add a test that verifies typed links round-trip through Supabase:

```js
it('should persist and load link types through Supabase', async () => {
  // This depends on the existing mock setup in the test file.
  // After storing two similar memories and verifying links exist,
  // also verify link.type === 'similar' on the loaded result.
});
```

If the mock doesn't support the new column yet, update it to store/return `link_type`.

### Verification
Run `npx vitest run`. All tests pass. Typed links survive Supabase round-trips.
```

---

### Prompt 7: Typed Edges — Events and Writethrough

```text
You are continuing work on neolata-mem. Links now have types everywhere.

## Task
Update the `emit('link', ...)` call in `store()` and the link event in the new `link()` method to include the `type` field.

### Changes to `src/graph.mjs`:

In `store()`, find:
```js
this.emit('link', { sourceId: id, targetId: link.id, similarity: link.similarity });
```
Change to:
```js
this.emit('link', { sourceId: id, targetId: link.id, similarity: link.similarity, type: 'similar' });
```

The `link()` method already emits with type (from Prompt 5). No change needed there.

### Changes to `test/events.test.mjs`:

Add or update a test that verifies the link event includes `type`:

```js
it('should emit link events with type', async () => {
  const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
  const events = [];
  graph.on('link', (ev) => events.push(ev));
  
  await graph.store('a', 'memory about testing');
  await graph.store('a', 'another memory about testing code');
  
  expect(events.length).toBeGreaterThan(0);
  for (const ev of events) {
    expect(ev.type).toBe('similar');
  }
});
```

### Verification
Run `npx vitest run`. All tests pass. Phase 1 (Typed Edges) is complete.
```

---

### Prompt 8: SM-2 Decay — New Fields in `reinforce()`

```text
You are starting Phase 2 of neolata-mem v0.6.0: SM-2 Spaced Repetition Decay.

## Background
Currently, `reinforce()` in graph.mjs increments `accessCount` and boosts `importance`. The decay formula (`calcStrength()`) uses a flat exponential with a linear access bonus.

We're adding SM-2-inspired spaced repetition: memories that are reinforced at increasing intervals become more resistant to decay.

## Task
Add `stability` and `lastReviewInterval` fields to `reinforce()`.

### Changes to `src/graph.mjs`:

1. Add config defaults in the constructor:
   Find:
   ```js
   this.config = {
     linkThreshold: config.linkThreshold ?? 0.5,
     ...
     evolveMinIntervalMs: config.evolveMinIntervalMs ?? 1000,
   };
   ```
   Add before the closing `};`:
   ```js
   initialStability: config.initialStability ?? 1.0,
   stabilityGrowth: config.stabilityGrowth ?? 2.0,
   ```

2. Update `reinforce()` to calculate and write stability:
   
   Find in `reinforce()`:
   ```js
   const oldImportance = mem.importance;
   mem.importance = Math.min(1.0, (mem.importance || 0.5) + boost);
   mem.accessCount = (mem.accessCount || 0) + 1;
   mem.updated_at = new Date().toISOString();
   ```
   
   Replace with:
   ```js
   const oldImportance = mem.importance;
   const now = new Date();
   const lastTouch = new Date(mem.updated_at || mem.created_at);
   const daysSinceTouch = (now.getTime() - lastTouch.getTime()) / (1000 * 60 * 60 * 24);
   
   mem.importance = Math.min(1.0, (mem.importance || 0.5) + boost);
   mem.accessCount = (mem.accessCount || 0) + 1;
   
   // SM-2 stability: grows more with spaced reviews
   const previousInterval = mem.lastReviewInterval || 1;
   const currentInterval = Math.max(0.01, daysSinceTouch);  // floor to prevent division issues
   const spacingFactor = Math.min(3.0, currentInterval / Math.max(1, previousInterval));
   const growthRate = this.config.stabilityGrowth;
   mem.stability = (mem.stability ?? this.config.initialStability) * (1.0 + (growthRate - 1.0) * spacingFactor / 3.0);
   mem.lastReviewInterval = currentInterval;
   
   mem.updated_at = now.toISOString();
   ```

3. Update the typedef at the top of graph.mjs to include the new fields:
   Add to the typedef:
   ```js
   stability?: number, lastReviewInterval?: number
   ```

### Tests — add to `test/graph.test.mjs`:

```js
describe('reinforce with stability', () => {
  it('should set stability and lastReviewInterval on reinforce', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Important fact');
    
    const result = await graph.reinforce(r.id);
    const mem = graph.memories.find(m => m.id === r.id);
    
    expect(typeof mem.stability).toBe('number');
    expect(mem.stability).toBeGreaterThan(0);
    expect(typeof mem.lastReviewInterval).toBe('number');
  });
  
  it('should increase stability more with spaced reinforcement', async () => {
    const graph = createTestGraph();
    
    // Memory reinforced rapidly (stability grows slowly)
    const r1 = await graph.store('a', 'Rapid reinforced');
    await graph.reinforce(r1.id);
    await graph.reinforce(r1.id);
    await graph.reinforce(r1.id);
    const rapid = graph.memories.find(m => m.id === r1.id);
    
    // Memory reinforced with simulated spacing
    const r2 = await graph.store('a', 'Spaced reinforced');
    const mem2 = graph.memories.find(m => m.id === r2.id);
    
    // Simulate: first reinforce after 1 day
    mem2.updated_at = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await graph.reinforce(r2.id);
    
    // Second reinforce after 3 days
    mem2.updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await graph.reinforce(r2.id);
    
    // Third reinforce after 7 days
    mem2.updated_at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await graph.reinforce(r2.id);
    
    const spaced = graph.memories.find(m => m.id === r2.id);
    
    // Spaced should have higher stability than rapid
    expect(spaced.stability).toBeGreaterThan(rapid.stability);
  });
});
```

### Verification
Run `npx vitest run`. All tests pass. Reinforce now writes SM-2 stability fields.
```

---

### Prompt 9: SM-2 Decay — Update `calcStrength()` Formula

```text
You are continuing Phase 2 of neolata-mem v0.6.0. `reinforce()` now writes `stability` and `lastReviewInterval`.

## Task
Update `calcStrength()` to use SM-2 retrievability when the memory has a `stability` field, while preserving the exact current behavior for memories without it.

### Changes to `src/graph.mjs`:

Replace the current `calcStrength()` method entirely:

```js
/**
 * Calculate decay strength for a memory (0.0 = dead, 1.0 = strong).
 *
 * Two modes:
 * 1. SM-2 mode (memory has `stability` field): Uses exponential forgetting
 *    curve where stability grows with spaced reinforcement.
 * 2. Legacy mode (no `stability`): Original formula for backward compat.
 *
 * Shared factors:
 *   - Base importance
 *   - Link reinforcement (+0.05 per link, max +0.3)
 *   - Category weight (decisions 1.3x, preferences 1.4x, insights 1.1x)
 *
 * @param {Memory} mem
 * @returns {{ strength: number, ageDays: number, lastTouchDays: number, linkCount: number, mode: string }}
 */
calcStrength(mem) {
  const now = Date.now();
  const created = new Date(mem.created_at).getTime();
  const updated = new Date(mem.updated_at || mem.created_at).getTime();
  const ageDays = (now - created) / (1000 * 60 * 60 * 24);
  const lastTouchDays = (now - updated) / (1000 * 60 * 60 * 24);

  const base = mem.importance || 0.5;
  const linkCount = (mem.links || []).length;
  const linkBonus = Math.min(0.3, linkCount * 0.05);
  const stickyCategories = { decision: 1.3, preference: 1.4, insight: 1.1 };
  const categoryWeight = stickyCategories[mem.category] || 1.0;

  if (mem.stability != null) {
    // SM-2 mode: retrievability based on stability
    const stability = Math.max(0.1, mem.stability);
    const retrievability = Math.exp(-0.5 * lastTouchDays / stability);
    const strength = Math.min(1.0, (base * retrievability * categoryWeight) + linkBonus);
    return { strength, ageDays, lastTouchDays, linkCount, base, retrievability, categoryWeight, stability, mode: 'sm2' };
  }

  // Legacy mode: original formula
  const HALF_LIFE = this.config.decayHalfLifeDays;
  const ageFactor = Math.max(0.1, Math.pow(0.5, ageDays / HALF_LIFE));
  const touchFactor = Math.max(0.1, Math.pow(0.5, lastTouchDays / (HALF_LIFE * 2)));
  const accessBonus = Math.min(0.2, (mem.accessCount || 0) * 0.02);
  const strength = Math.min(1.0, (base * ageFactor * touchFactor * categoryWeight) + linkBonus + accessBonus);
  return { strength, ageDays, lastTouchDays, linkCount, base, ageFactor, touchFactor, categoryWeight, mode: 'legacy' };
}
```

### Tests — add to `test/graph.test.mjs`:

```js
describe('calcStrength', () => {
  it('should use legacy mode for memories without stability', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Test memory');
    const mem = graph.memories.find(m => m.id === r.id);
    
    const result = graph.calcStrength(mem);
    expect(result.mode).toBe('legacy');
    expect(result.strength).toBeGreaterThan(0);
    expect(result.strength).toBeLessThanOrEqual(1);
  });

  it('should use SM-2 mode for memories with stability', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Test memory');
    const mem = graph.memories.find(m => m.id === r.id);
    mem.stability = 5.0;
    
    const result = graph.calcStrength(mem);
    expect(result.mode).toBe('sm2');
    expect(result.stability).toBe(5.0);
    expect(result.strength).toBeGreaterThan(0);
  });

  it('should give higher strength to memories with higher stability', async () => {
    const graph = createTestGraph();
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    
    const lowStab = { importance: 0.7, stability: 1.0, links: [], category: 'fact', created_at: tenDaysAgo, updated_at: tenDaysAgo };
    const highStab = { importance: 0.7, stability: 20.0, links: [], category: 'fact', created_at: tenDaysAgo, updated_at: tenDaysAgo };
    
    const lowResult = graph.calcStrength(lowStab);
    const highResult = graph.calcStrength(highStab);
    
    expect(highResult.strength).toBeGreaterThan(lowResult.strength);
  });
});
```

### Verification
Run `npx vitest run`. All 144+ existing tests still pass (memories without stability use legacy formula). New tests pass.
```

---

### Prompt 10: SM-2 Decay — Supabase Fields and Health Report

```text
You are finishing Phase 2 of neolata-mem v0.6.0.

## Task
1. Update Supabase storage to persist `stability` and `lastReviewInterval`.
2. Update `health()` to include stability statistics.

### Changes to `src/supabase-storage.mjs`:

1. In `toRow()`, add:
   ```js
   stability: mem.stability ?? null,
   last_review_interval: mem.lastReviewInterval ?? null,
   ```

2. In `fromRow()`, add:
   ```js
   stability: row.stability ?? undefined,
   lastReviewInterval: row.last_review_interval ?? undefined,
   ```

3. In the `load()` SELECT query, add `stability,last_review_interval` to the column list.

### Changes to `src/graph.mjs`:

In `health()`, after the strength distribution loop, add stability stats:

```js
const stabilityValues = this.memories
  .filter(m => m.stability != null)
  .map(m => m.stability);
const avgStability = stabilityValues.length
  ? +(stabilityValues.reduce((a, b) => a + b, 0) / stabilityValues.length).toFixed(2)
  : null;
const memoriesWithSM2 = stabilityValues.length;
```

Add to the return object:
```js
avgStability,
memoriesWithSM2,
```

### Tests — add to appropriate test files:

In `test/graph.test.mjs`, add to the `health` describe block (or create one):

```js
it('should include stability stats in health report', async () => {
  const graph = createTestGraph();
  await graph.store('a', 'Memory one');
  await graph.store('a', 'Memory two');
  
  // Reinforce one to give it stability
  const id = graph.memories[0].id;
  await graph.reinforce(id);
  
  const report = await graph.health();
  expect(report.memoriesWithSM2).toBe(1);
  expect(typeof report.avgStability).toBe('number');
});
```

### Verification
Run `npx vitest run`. All tests pass. Phase 2 (SM-2 Decay) is complete.
```

---

### Prompt 11: Bi-Temporal — `eventTime` in `store()` and `storeMany()`

```text
You are starting Phase 3 of neolata-mem v0.6.0: Bi-Temporal Tracking.

## Task
Add optional `eventTime` parameter to `store()` and `storeMany()` that writes an `event_at` field.

### Changes to `src/graph.mjs`:

1. Update the `store()` method signature and body:

   Current options destructuring:
   ```js
   async store(agent, text, { category = 'fact', importance = 0.7, tags = [] } = {})
   ```
   Change to:
   ```js
   async store(agent, text, { category = 'fact', importance = 0.7, tags = [], eventTime } = {})
   ```

   After input validation (before the memory cap check), add eventTime validation:
   ```js
   let eventAt = undefined;
   if (eventTime !== undefined) {
     if (typeof eventTime === 'string') {
       const parsed = new Date(eventTime);
       if (isNaN(parsed.getTime())) throw new Error('eventTime must be a valid ISO 8601 date string');
       eventAt = parsed.toISOString();
     } else if (eventTime instanceof Date) {
       if (isNaN(eventTime.getTime())) throw new Error('eventTime must be a valid Date');
       eventAt = eventTime.toISOString();
     } else {
       throw new Error('eventTime must be a string or Date');
     }
   }
   ```

   In the `newMem` object construction, add:
   ```js
   const newMem = {
     id, agent, memory: text, category, importance,
     tags: tags || [],
     embedding,
     links: topLinks.map(l => ({ id: l.id, similarity: l.similarity, type: 'similar' })),
     created_at: now,
     updated_at: now,
     ...(eventAt !== undefined && { event_at: eventAt }),
   };
   ```

2. Update `storeMany()`:

   In the item processing loop, extract eventTime:
   ```js
   const item = typeof items[i] === 'string' ? { text: items[i] } : items[i];
   ```
   After this, add eventTime handling:
   ```js
   let eventAt = undefined;
   if (item.eventTime !== undefined) {
     const parsed = new Date(item.eventTime);
     if (isNaN(parsed.getTime())) throw new Error(`items[${i}].eventTime is not a valid date`);
     eventAt = parsed.toISOString();
   }
   ```

   In the `newMem` object, add:
   ```js
   ...(eventAt !== undefined && { event_at: eventAt }),
   ```

3. Update typedef at top of graph.mjs:
   Add `event_at?: string` to the Memory typedef.

### Tests — add to `test/graph.test.mjs`:

```js
describe('bi-temporal', () => {
  it('should store event_at when eventTime is provided', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Server migrated to AWS', {
      eventTime: '2026-01-15T00:00:00Z',
    });
    const mem = graph.memories.find(m => m.id === r.id);
    expect(mem.event_at).toBe('2026-01-15T00:00:00.000Z');
    // created_at should be different (now)
    expect(mem.created_at).not.toBe(mem.event_at);
  });

  it('should not set event_at when eventTime is omitted', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Just a normal memory');
    const mem = graph.memories.find(m => m.id === r.id);
    expect(mem.event_at).toBeUndefined();
  });

  it('should reject invalid eventTime', async () => {
    const graph = createTestGraph();
    await expect(graph.store('a', 'test', { eventTime: 'not-a-date' }))
      .rejects.toThrow('eventTime must be a valid ISO 8601 date string');
  });

  it('should support eventTime in storeMany', async () => {
    const graph = createTestGraph();
    const result = await graph.storeMany('a', [
      { text: 'Event A', eventTime: '2026-01-10' },
      { text: 'Event B' },
    ]);
    expect(result.stored).toBe(2);
    const memA = graph.memories.find(m => m.memory === 'Event A');
    const memB = graph.memories.find(m => m.memory === 'Event B');
    expect(memA.event_at).toBeDefined();
    expect(memB.event_at).toBeUndefined();
  });
});
```

### Verification
Run `npx vitest run`. All tests pass.
```

---

### Prompt 12: Bi-Temporal — `timeline()` and `search()` Temporal Filters

```text
You are continuing Phase 3 of neolata-mem v0.6.0.

## Task
1. Update `timeline()` to use `event_at` when present.
2. Add `before`/`after` temporal filters to `search()`.

### Changes to `src/graph.mjs`:

1. **`timeline()` method** — currently:
   ```js
   async timeline(agent = null, days = 7)
   ```
   Change to:
   ```js
   async timeline(agent = null, days = 7, { timeField = 'auto' } = {})
   ```

   Change the date extraction:
   Current:
   ```js
   const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
   mems = mems.filter(m => new Date(m.created_at).getTime() > cutoff);

   const byDate = {};
   for (const m of mems) {
     const date = m.created_at.split('T')[0];
   ```
   
   New:
   ```js
   function getTime(m) {
     if (timeField === 'event') return m.event_at ? new Date(m.event_at).getTime() : null;
     if (timeField === 'created') return new Date(m.created_at).getTime();
     // 'auto': prefer event_at, fall back to created_at
     return new Date(m.event_at || m.created_at).getTime();
   }

   const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
   mems = mems.filter(m => {
     const t = getTime(m);
     return t !== null && t > cutoff;
   });

   const byDate = {};
   for (const m of mems) {
     const ts = m.event_at || m.created_at;
     if (timeField === 'created') {
       var date = m.created_at.split('T')[0];
     } else if (timeField === 'event') {
       if (!m.event_at) continue;
       var date = m.event_at.split('T')[0];
     } else {
       var date = (m.event_at || m.created_at).split('T')[0];
     }
   ```

   Actually, let me simplify. Replace the date extraction section more cleanly:

   ```js
   const getTimestamp = (m) => {
     if (timeField === 'event') return m.event_at ? new Date(m.event_at).getTime() : null;
     if (timeField === 'created') return new Date(m.created_at).getTime();
     return new Date(m.event_at || m.created_at).getTime();
   };
   const getDateStr = (m) => {
     if (timeField === 'event') return m.event_at ? m.event_at.split('T')[0] : null;
     if (timeField === 'created') return m.created_at.split('T')[0];
     return (m.event_at || m.created_at).split('T')[0];
   };

   const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
   mems = mems.filter(m => {
     const t = getTimestamp(m);
     return t !== null && t > cutoff;
   });

   const byDate = {};
   for (const m of mems) {
     const date = getDateStr(m);
     if (!date) continue;
     if (!byDate[date]) byDate[date] = [];
     byDate[date].push({ id: m.id, memory: m.memory, agent: m.agent, category: m.category, importance: m.importance, links: (m.links || []).length });
   }
   return { days, agent, timeField, dates: byDate, total: mems.length };
   ```

2. **`search()` method** — add temporal filtering:

   Current options destructuring:
   ```js
   async search(agent, query, { limit = 10, minSimilarity = 0 } = {})
   ```
   Change to:
   ```js
   async search(agent, query, { limit = 10, minSimilarity = 0, before, after } = {})
   ```

   After the `if (agent) candidates = candidates.filter(...)` line, add temporal filtering:
   ```js
   if (before || after) {
     const beforeMs = before ? new Date(before).getTime() : Infinity;
     const afterMs = after ? new Date(after).getTime() : -Infinity;
     if (before && isNaN(beforeMs)) throw new Error('search: "before" must be a valid date string');
     if (after && isNaN(afterMs)) throw new Error('search: "after" must be a valid date string');
     candidates = candidates.filter(m => {
       const t = new Date(m.event_at || m.created_at).getTime();
       return t <= beforeMs && t >= afterMs;
     });
   }
   ```

3. **`context()` method** — pass through temporal filters:

   Current:
   ```js
   async context(agent, query, { maxMemories = 15 } = {})
   ```
   Change to:
   ```js
   async context(agent, query, { maxMemories = 15, before, after } = {})
   ```

   In the search call inside context:
   ```js
   const results = await this.search(null, query, { limit: 8 });
   ```
   Change to:
   ```js
   const results = await this.search(null, query, { limit: 8, before, after });
   ```

### Tests — add to `test/graph.test.mjs`:

```js
describe('bi-temporal timeline', () => {
  it('should group by event_at when available', async () => {
    const graph = createTestGraph();
    // Store memory with past event time
    await graph.store('a', 'Server migrated', { eventTime: '2026-01-15T12:00:00Z' });
    // Store memory without event time (uses created_at = now)
    await graph.store('a', 'Normal memory');
    
    const tl = await graph.timeline('a', 365);
    const dates = Object.keys(tl.dates);
    expect(dates).toContain('2026-01-15');
  });

  it('should filter by timeField=event', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Has event time', { eventTime: '2026-01-15T12:00:00Z' });
    await graph.store('a', 'No event time');
    
    const tl = await graph.timeline('a', 365, { timeField: 'event' });
    // Only the memory with event_at should appear
    expect(tl.total).toBe(1);
  });
});

describe('search with temporal filters', () => {
  it('should filter by before/after', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'January event', { eventTime: '2026-01-15T00:00:00Z' });
    await graph.store('a', 'February event', { eventTime: '2026-02-15T00:00:00Z' });
    await graph.store('a', 'March event', { eventTime: '2026-03-15T00:00:00Z' });
    
    const results = await graph.search('a', 'event', {
      after: '2026-02-01',
      before: '2026-02-28',
    });
    
    expect(results.length).toBe(1);
    expect(results[0].memory).toBe('February event');
  });

  it('should use event_at for temporal filtering', async () => {
    const graph = createTestGraph();
    // Store now but event was in January
    await graph.store('a', 'Past event', { eventTime: '2026-01-10T00:00:00Z' });
    
    const results = await graph.search('a', 'event', { before: '2026-01-31' });
    expect(results.length).toBe(1);
    
    const noResults = await graph.search('a', 'event', { after: '2026-03-01' });
    expect(noResults.length).toBe(0);
  });
});
```

### Verification
Run `npx vitest run`. All tests pass.
```

---

### Prompt 13: Bi-Temporal — Supabase `event_at` Field

```text
You are finishing Phase 3 of neolata-mem v0.6.0.

## Task
Update Supabase storage to persist and read the `event_at` field.

### Changes to `src/supabase-storage.mjs`:

1. In `toRow()`, add:
   ```js
   event_at: mem.event_at || null,
   ```

2. In `fromRow()`, add:
   ```js
   event_at: row.event_at || undefined,
   ```

3. In `load()`, add `event_at` to the SELECT column list:
   Current:
   ```js
   `...?select=id,agent_id,content,category,importance,tags,embedding,created_at,updated_at,access_count&...`
   ```
   Change to:
   ```js
   `...?select=id,agent_id,content,category,importance,tags,embedding,created_at,updated_at,access_count,stability,last_review_interval,event_at&...`
   ```
   (Note: this also adds the SM-2 fields from Prompt 10 if they weren't added to the SELECT yet.)

4. In `toArchiveRow()`, add:
   ```js
   event_at: mem.event_at || null,
   ```

5. In `fromArchiveRow()`, add:
   ```js
   event_at: row.event_at || undefined,
   ```

### Verification
Run `npx vitest run`. All tests pass. Phase 3 (Bi-Temporal) is complete.
```

---

### Prompt 14: Integration — Factory Wiring and End-to-End Test

```text
You are finishing neolata-mem v0.6.0 with integration wiring.

## Task
1. Ensure `createMemory()` in index.mjs passes new config options through.
2. Write an end-to-end integration test covering all three new features together.
3. Verify all existing tests still pass (backward compatibility).

### Changes to `src/index.mjs`:

The factory already passes `opts.graph || {}` to the config. The new config fields (`initialStability`, `stabilityGrowth`) will pass through automatically since the constructor handles them. No changes needed in index.mjs — just verify.

### New file: `test/v060-integration.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';

function fakeEmbeddings() {
  return {
    name: 'fake', model: 'fake',
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      return input.map(t => {
        const vec = new Array(64).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 64] += t.charCodeAt(i) / 1000;
        const mag = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
        return vec.map(v => v / (mag || 1));
      });
    },
  };
}

function mockLLM(response) {
  return {
    name: 'mock-llm',
    async chat() { return JSON.stringify(response); },
  };
}

describe('v0.6.0 Integration', () => {
  it('full lifecycle: store → typed links → evolve → supersedes → search temporal → reinforce → SM-2 decay', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      llm: mockLLM({
        conflicts: [{ index: 0, reason: 'version updated' }],
        updates: [],
        novel: true,
      }),
      config: {
        linkThreshold: 0.1,
        initialStability: 1.0,
        stabilityGrowth: 2.0,
      },
    });

    // 1. Store with eventTime (bi-temporal)
    const r1 = await graph.store('agent-1', 'Server runs on port 3000', {
      eventTime: '2026-01-15T00:00:00Z',
      category: 'fact',
    });
    expect(r1.id).toBeTruthy();
    const mem1 = graph.memories.find(m => m.id === r1.id);
    expect(mem1.event_at).toBe('2026-01-15T00:00:00.000Z');

    // 2. Store related memory — verify typed links
    const r2 = await graph.store('agent-1', 'Server uses port 3000 for the API', {
      eventTime: '2026-01-16T00:00:00Z',
    });
    const mem2 = graph.memories.find(m => m.id === r2.id);
    if (mem2.links.length > 0) {
      expect(mem2.links[0].type).toBe('similar');
    }

    // 3. Temporal search — find January memories only
    const janResults = await graph.search('agent-1', 'server port', {
      after: '2026-01-01',
      before: '2026-01-31',
    });
    expect(janResults.length).toBe(2);

    // 4. Evolve — should archive r1 and create supersedes link
    const evolved = await graph.evolve('agent-1', 'Server now runs on port 8080', {
      category: 'fact',
    });
    expect(evolved.actions.some(a => a.type === 'archived')).toBe(true);
    if (evolved.id) {
      const newMem = graph.memories.find(m => m.id === evolved.id);
      if (newMem) {
        const supersedesLinks = newMem.links.filter(l => l.type === 'supersedes');
        expect(supersedesLinks.length).toBeGreaterThan(0);
      }
    }

    // 5. Reinforce — verify SM-2 stability
    if (evolved.id) {
      await graph.reinforce(evolved.id);
      const reinforced = graph.memories.find(m => m.id === evolved.id);
      expect(reinforced.stability).toBeDefined();
      expect(reinforced.stability).toBeGreaterThan(0);

      // Verify calcStrength uses SM-2 mode
      const strength = graph.calcStrength(reinforced);
      expect(strength.mode).toBe('sm2');
    }

    // 6. Health report includes new fields
    const health = await graph.health();
    expect(health.total).toBeGreaterThan(0);
    expect('memoriesWithSM2' in health).toBe(true);

    // 7. Timeline with bi-temporal
    const tl = await graph.timeline('agent-1', 365);
    expect(tl.total).toBeGreaterThan(0);

    // 8. Traverse with type filter
    if (evolved.id) {
      const allTraversal = await graph.traverse(evolved.id, 2);
      const similarOnly = await graph.traverse(evolved.id, 2, { types: ['similar'] });
      // similarOnly should not follow supersedes links
      expect(similarOnly.reached).toBeLessThanOrEqual(allTraversal.reached);
    }
  });

  it('backward compatibility: old-format memories work correctly', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      config: { linkThreshold: 0.1 },
    });

    // Manually inject old-format memories (no type, no stability, no event_at)
    const now = new Date().toISOString();
    graph.memories = [
      {
        id: 'mem_legacy-1', agent: 'a', memory: 'old memory one', category: 'fact',
        importance: 0.7, tags: [], embedding: null,
        links: [{ id: 'mem_legacy-2', similarity: 0.8 }],  // no type
        created_at: now, updated_at: now,
        // no stability, no lastReviewInterval, no event_at
      },
      {
        id: 'mem_legacy-2', agent: 'a', memory: 'old memory two', category: 'fact',
        importance: 0.7, tags: [], embedding: null,
        links: [{ id: 'mem_legacy-1', similarity: 0.8 }],
        created_at: now, updated_at: now,
      },
    ];
    graph.loaded = true;
    graph._rebuildIndexes();

    // links() should default type to 'similar'
    const links = await graph.links('mem_legacy-1');
    expect(links.links[0].type).toBe('similar');

    // calcStrength should use legacy mode
    const strength = graph.calcStrength(graph.memories[0]);
    expect(strength.mode).toBe('legacy');

    // timeline should work (no event_at → uses created_at)
    const tl = await graph.timeline('a', 1);
    expect(tl.total).toBe(2);

    // search should work
    const results = await graph.search('a', 'old memory');
    expect(results.length).toBe(2);

    // reinforce should add stability (progressive migration)
    await graph.reinforce('mem_legacy-1');
    const mem = graph.memories.find(m => m.id === 'mem_legacy-1');
    expect(mem.stability).toBeDefined();
    expect(graph.calcStrength(mem).mode).toBe('sm2');
  });
});
```

### Verification
Run `npx vitest run`. ALL tests pass — both the 144 existing tests and all new tests. No regressions.
```

---

### Prompt 15: Documentation Update

```text
You are finalizing neolata-mem v0.6.0.

## Task
Update the README.md to document the three new features. Also update the package.json version to 0.6.0.

### Changes to `package.json`:
Change `"version": "0.5.3"` to `"version": "0.6.0"`.

### Changes to `README.md`:

Add a new section after the existing feature documentation. Keep the existing content — add to it. Include:

#### Typed Edges (v0.6.0)
- Links now carry a `type` field: `'similar'`, `'supersedes'`, `'caused_by'`, `'part_of'`, `'related'`, etc.
- Auto-generated links get `type: 'similar'`
- `evolve()` creates `type: 'supersedes'` links to archived memories
- Manual links: `graph.link(sourceId, targetId, { type: 'caused_by' })`
- Manual unlink: `graph.unlink(sourceId, targetId)`
- Type filtering: `graph.traverse(id, 2, { types: ['similar'] })`
- Backward compatible: old links without `type` default to `'similar'`

#### SM-2 Spaced Repetition Decay (v0.6.0)
- `reinforce()` now tracks `stability` and `lastReviewInterval`
- Memories reinforced at increasing intervals become more resistant to decay
- `calcStrength()` uses SM-2 retrievability for memories with stability
- Memories without stability use the original formula (backward compatible)
- Config: `initialStability` (default 1.0), `stabilityGrowth` (default 2.0)

#### Bi-Temporal Tracking (v0.6.0)
- `store()` accepts optional `eventTime`: when the event happened (vs when it was recorded)
- Stored as `event_at` field on memory objects
- `timeline()` uses `event_at` when present (configurable with `timeField` option)
- `search()` supports `before`/`after` temporal filters
- `context()` passes temporal filters through to search

#### Migration from v0.5.x
- **No breaking changes.** All new features are additive.
- Existing memories work unchanged (legacy decay formula, links default to `type: 'similar'`)
- First `reinforce()` call on old memories starts SM-2 tracking (progressive migration)
- Supabase users: run these optional migrations for new columns:
  ```sql
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS stability FLOAT;
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_review_interval FLOAT;
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;
  ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS link_type TEXT DEFAULT 'similar';
  ```

### Verification
Run `npx vitest run` one final time. All tests pass. Version bumped. Docs updated.
```

---

## Summary

| Prompt | Feature | What it does | New tests |
|--------|---------|-------------|-----------|
| 1 | Typed Edges | `type: 'similar'` on store/backlink creation | 1 |
| 2 | Typed Edges | Read-time default for old links | 1 |
| 3 | Typed Edges | `supersedes` links in evolve() | 1 |
| 4 | Typed Edges | Type filter for traverse() + path() | 2 |
| 5 | Typed Edges | Manual link() + unlink() | 5 |
| 6 | Typed Edges | Supabase link_type column | 1 |
| 7 | Typed Edges | Events include type | 1 |
| 8 | SM-2 Decay | stability + lastReviewInterval in reinforce() | 2 |
| 9 | SM-2 Decay | New calcStrength() formula | 3 |
| 10 | SM-2 Decay | Supabase fields + health report | 1 |
| 11 | Bi-Temporal | eventTime in store() + storeMany() | 4 |
| 12 | Bi-Temporal | timeline() + search() temporal filters | 4 |
| 13 | Bi-Temporal | Supabase event_at column | 0 |
| 14 | Integration | Factory wiring + E2E test + backward compat | 2 |
| 15 | Docs | README + version bump | 0 |
| **Total** | | | **~28 new tests** |
