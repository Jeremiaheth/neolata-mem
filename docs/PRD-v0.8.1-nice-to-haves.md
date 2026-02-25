# PRD: neolata-mem v0.8.1 — “Memory Intelligence Nice-to-Haves”

> **Goal:** Extend v0.8 “Trustworthy Memory” with three high-leverage features that improve correctness, debuggability, and poisoning resistance without introducing “LLM-per-write” costs.

> **Tagline:** “Self-healing, trustworthy memory for AI agents”

> **Version:** 0.8.0 → 0.8.1 (additive / backward compatible)

> **Depends on:** PRD-v0.8 core features (claims, provenance+trust, trust-gated supersession, reranking, budget-aware context, consolidate).

> **Files touched (expected):** `src/graph.mjs`, `src/index.mjs`, `src/storage.mjs`, `src/supabase-storage.mjs`, `sql/schema.sql` (migration)

---

## Table of Contents

1. [Context & Motivation](#1-context--motivation)
2. [Feature 7: Predicate Schema Registry](#2-feature-7-predicate-schema-registry)
3. [Feature 8: Explainability API](#3-feature-8-explainability-api)
4. [Feature 9: Quarantine Lane](#4-feature-9-quarantine-lane)
5. [Migration & Backward Compatibility](#5-migration--backward-compatibility)
6. [Success Metrics](#6-success-metrics)
7. [Codex Prompts](#7-codex-prompts)
8. [Summary of Deliverables](#8-summary-of-deliverables)

---

## 1. Context & Motivation

v0.8 establishes **belief-update semantics** (claims), **provenance/trust**, and **trust-gated supersession**.

The “nice-to-haves” below make v0.8 *feel* best-in-class in practice:

- **Predicate Schema Registry** prevents false contradictions and enables deterministic conflict handling by predicate type.
- **Explainability API** makes retrieval and supersession debuggable in production (“why did I see this?”).
- **Quarantine Lane** ensures suspicious / blocked-conflict memories don’t leak into default context (poisoning resistance + reduced contradiction blindness).

### Non-goals

- No new external connectors/loaders in v0.8.1
- No mandatory LLM calls (all features must work without an LLM)
- No full ontology system (lightweight predicate metadata only)
- No “perfect” optimization (greedy packing remains acceptable)

---

## 2. Feature 7: Predicate Schema Registry

### What

Add a registry describing **predicate semantics**:

- **Cardinality:** `single` vs `multi`
- **Conflict policy:** what to do when `(subject,predicate)` collides with different values
- Optional: normalization hint and dedup behavior

This registry is used by `store()`, structural conflict checking, dedup/corroboration, and consolidate.

### Why

Structural contradiction detection in v0.8 assumes “same subject+predicate implies a single true value.” That is correct for predicates like `budget_is`, but wrong for predicates like `likes`, `has_skill`, `visited`, etc.

The registry reduces:
- false contradictions
- duplicate explosion
- retrieval noise (multiple near-identical values)

### Data Model

New in-memory structure:

```js
PredicateSchema = {
  predicate: string,

  // Semantics
  cardinality: 'single' | 'multi',

  // What to do when a “single” predicate collides with a different value
  // (subject+predicate match, value differs, validity overlaps)
  conflictPolicy: 'supersede' | 'require_review' | 'keep_both',

  // Optional value normalization (string key for deterministic behavior)
  // See Normalizers below.
  normalize?: 'none' | 'trim' | 'lowercase' | 'lowercase_trim' | 'currency',

  // Dedup behavior when the same (subject,predicate,value) is re-stored
  // - 'corroborate' = don’t add a new node; increment corroboration on the existing memory
  // - 'store' = store again as a separate memory node (not recommended)
  dedupPolicy?: 'corroborate' | 'store',
}
```

New config on graph:

```js
new MemoryGraph({
  predicateSchemas: {
    budget_is: { cardinality: 'single', conflictPolicy: 'supersede', normalize: 'currency', dedupPolicy: 'corroborate' },
    prefers_seat: { cardinality: 'single', conflictPolicy: 'require_review', normalize: 'lowercase_trim' },
    likes: { cardinality: 'multi', conflictPolicy: 'keep_both', normalize: 'lowercase_trim', dedupPolicy: 'corroborate' },
  }
})
```

Defaults:
- If no schema: `cardinality='single'`, `conflictPolicy='supersede'`, `normalize='none'`, `dedupPolicy='corroborate'`

> Note: keeping “single+supersede” default preserves v0.8 behavior for existing users.

### Normalizers

Implement as pure deterministic functions keyed by name:

- `none` → identity
- `trim` → `value.trim()`
- `lowercase` → `value.toLowerCase()`
- `lowercase_trim` → `value.trim().toLowerCase()`
- `currency` → best-effort normalize common currency strings (e.g., “$750”, “750 USD” → “USD 750”)

Store normalized output on claim:

```js
claim: {
  subject, predicate, value, normalizedValue?, scope, validFrom?, validUntil?
}
```

Conflict checks use `normalizedValue` when present, else `value`.

### API Changes

Public methods:

```js
mem.registerPredicate('likes', { cardinality: 'multi', conflictPolicy: 'keep_both', normalize: 'lowercase_trim' });

mem.registerPredicates({
  budget_is: { cardinality: 'single', conflictPolicy: 'supersede', normalize: 'currency' },
  likes: { cardinality: 'multi', conflictPolicy: 'keep_both', normalize: 'lowercase_trim' },
});

const schema = mem.getPredicateSchema('budget_is');
const all = mem.listPredicateSchemas();
```

### Store() Behavior Changes (when `claim` is present)

1) Determine schema: `schema = getPredicateSchema(claim.predicate)`
2) Normalize: `claim.normalizedValue = normalize(schema.normalize, claim.value)`
3) Detect collisions by `(subject,predicate)` among active memories **with overlapping validity**
4) Apply semantics:

**A) Cardinality = `multi`**
- Different values are **not contradictions**
- If an active memory has the *same normalized value*, treat as duplicate and:
  - default action: `corroborate(existingId)` and return `{ deduplicatedInto: existingId }`
  - unless `dedupPolicy='store'`

**B) Cardinality = `single`**
- Different values are contradictions *if* validity overlaps
- Then apply `conflictPolicy`:
  - `supersede`: use trust-gated supersession (v0.8 behavior)
  - `require_review`: do not supersede automatically → create a pending conflict and quarantine the new memory
  - `keep_both`: keep both memories active but mark conflict as resolved action=`keep_both` (still emit conflict event). *Default retrieval should not surface both; see Quarantine + Explainability.*

### Tests / Acceptance

- Schema registry stores and returns schemas
- `multi` predicate does **not** create pending conflict on different values
- Duplicate value for a `multi` predicate triggers corroboration + does not add a new memory (default)
- `single+require_review` predicate always produces a pending conflict + quarantines new memory
- Normalization causes “Seattle” and “ seattle ” to dedup for `lowercase_trim`
- Backward compat: no schemas configured → v0.8 behavior unchanged

---

## 3. Feature 8: Explainability API

### What

Provide a consistent “why” surface for:
- **why retrieved**
- **why ranked above/below others**
- **why excluded**
- **why superseded / why quarantined**

### Why

Memory systems fail quietly. The difference between “this is smart” and “this is unpredictable” is whether developers can answer:

- *Which memories were candidates?*
- *What got filtered out and why?*
- *What signals drove the final ranking?*
- *Why did a belief update supersede (or not)?*

### API Changes

#### search(): `explain` option (no breaking changes)

```js
const results = await mem.search('agent-1', 'budget', { explain: true });
```

Return type remains `Array`, but when `explain: true`, attach a `.meta` property to the array:

```js
results.meta = {
  query: 'budget',
  agent: 'agent-1',
  options: { /* sanitized opts */ },

  counts: {
    candidates: 120,
    afterAgentFilter: 80,
    afterStatusFilter: 60,
    afterSimilarity: 25,
    returned: 10,
  },

  excluded: {
    superseded: 10,
    disputed: 3,
    quarantined: 7,
    archived: 0,
    belowMinSimilarity: 35,
    scopeMismatch: 0,
    validityMismatch: 0,
  },
};
```

Each returned item includes `explain`:

```js
{
  id, memory, score, compositeScore, rankingSignals,
  explain: {
    retrieved: {
      vectorSimilarity: 0.82,
      keywordScore: 0.15,
      keywordHits: ['budget', 'usd'],
    },
    rerank: {
      weights: { relevance: 0.4, confidence: 0.25, recency: 0.2, importance: 0.15 },
      signals: { relevance: 0.82, confidence: 0.74, recency: 0.91, importance: 0.7 },
      compositeScore: 0.81,
    },
    status: {
      status: 'active',
      superseded_by: null,
      quarantine: null,
    },
  }
}
```

#### context(): `explain` option

```js
const ctx = await mem.context('agent-1', 'project status', { maxTokens: 2000, explain: true });
```

Add:

```js
ctx.explain = {
  searchMeta: results.meta,
  packing: {
    maxTokens: 2000,
    tokenEstimate: 1847,
    includedIds: ['mem1', 'mem2'],
    excluded: [{ id: 'mem9', reason: 'budget', value: 0.34 }],
  },
};
```

#### supersession + quarantine explain helpers

Add lightweight helpers:

```js
mem.explainMemory(memoryId)         // status/trust/confidence + provenance + claim summary
mem.explainSupersession(memoryId)   // if superseded: which memory superseded it + trust comparison snapshot (if available)
```

### Implementation Notes

- Explainability must be **cheap by default**:
  - Only compute keyword hit lists / excluded breakdown when `explain: true`
- Preserve privacy / security:
  - `meta.options` should not include raw embeddings, raw tool output IDs unless explicitly requested (debug-only)

### Tests / Acceptance

- `search({ explain:true })` returns array with `.meta`
- `.meta.counts.returned === results.length`
- returned items include `explain.retrieved` and `explain.rerank`
- excluded breakdown increments correctly when superseded/quarantined exist
- `context({ explain:true })` includes packing explain and excluded reasons
- Backward compat: without explain → output identical to v0.8

---

## 4. Feature 9: Quarantine Lane

### What

Introduce a **quarantine lane** for memories that should not enter default retrieval/context until reviewed.

Primary triggers:
- Trust-gated supersession blocked due to insufficient trust (`newTrust < existingTrust`)
- Predicate schema says `conflictPolicy='require_review'`
- Caller explicitly flags input as suspicious (`opts.quarantine: true`)

### Why

Trust-gating prevents override, but **does not prevent contamination** if the new (conflicting) memory is still active and retrievable.

Quarantine makes “blocked conflicts” safe by default:
- the system retains the evidence
- but agents don’t see it unless explicitly allowed

### Data Model

Extend status enum:

```js
status: 'active' | 'superseded' | 'disputed' | 'quarantined' | 'archived'
```

Add optional quarantine metadata:

```js
quarantine?: {
  reason: 'trust_insufficient' | 'predicate_requires_review' | 'suspicious_input' | 'manual',
  details?: string,
  created_at: string,
  resolved_at?: string,
  resolution?: 'activated' | 'rejected' | 'kept_quarantined',
}
```

### API Changes

#### store(): quarantine behavior

- If collision occurs and supersession is blocked OR schema requires review:
  - store new memory as `status='quarantined'`
  - write a pending conflict record
  - return `{ pendingConflictId, quarantined: true }`

Optional override:

```js
await mem.store(agent, text, {
  claim,
  provenance,
  onConflict: 'quarantine' | 'keep_active', // default: 'quarantine'
});
```

> Default must be `quarantine` to keep the “poisoning resistant by default” promise.

#### Retrieval filtering defaults

Default retrieval should include only `status === 'active'`.

Add options:
- `includeSuperseded?: boolean`
- `includeDisputed?: boolean`
- `includeQuarantined?: boolean`

#### Review actions

Add:

```js
await mem.listQuarantined({ agent, limit: 50 });

await mem.reviewQuarantine(memoryId, { action: 'activate' | 'reject', reason?: string });
// - activate: status -> 'active' (and optionally re-run conflict resolution if claim present)
// - reject: archive/remove it

await mem.quarantine(memoryId, { reason: 'manual', details: 'flagged by operator' });
```

Integrate with `resolveConflict()`:
- If a quarantined memory is the `newId` in a conflict and action is:
  - `supersede`: set new active + supersede existing
  - `keep_both`: set new active (existing remains active)
  - `reject`: archive/remove new memory
- Always mark quarantine resolved accordingly.

### Consolidation interaction

`consolidate()` should optionally prune quarantined memories:

- `pruneQuarantined: true` (default false)
- `quarantineMaxAgeDays: 30` (default 30)
- Only prune quarantined memories with `accessCount === 0` (or never retrieved)

### Tests / Acceptance

- Blocked trust supersession → new memory is quarantined and does not appear in default search/context
- `includeQuarantined: true` returns quarantined memories
- `listQuarantined()` returns quarantined only
- `reviewQuarantine('activate')` flips status to active
- `reviewQuarantine('reject')` archives/removes
- Schema `require_review` always quarantines on conflict
- Backward compat: if user opts `onConflict:'keep_active'` behavior matches v0.8

---

## 5. Migration & Backward Compatibility

### Backward Compatibility

- Existing memories remain valid; default missing fields:
  - `status` defaults to `'active'`
  - `quarantine` defaults to `undefined`
- Predicate schemas are optional; absence preserves v0.8 behavior
- Explainability is opt-in (`explain: true`)

### Supabase Migration

Add quarantine column (optional but recommended):

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS quarantine jsonb;

-- Index to help “quarantine inbox” queries
CREATE INDEX IF NOT EXISTS idx_memories_quarantined
  ON memories (status)
  WHERE status = 'quarantined';
```

Update search RPC(s) / queries:
- default `filter_status = 'active'`
- allow filtering for `quarantined` when requested

---

## 6. Success Metrics

1) **Contradiction leakage**  
% of default contexts containing contradictory single-cardinality claims for same (subject,predicate) should decrease vs v0.8 baseline.

2) **Poisoning contamination**  
% of blocked conflicts that still appear in default retrieval should be **0%** (quarantine prevents leakage).

3) **Debug time**  
Median time-to-diagnose “why did memory X show up?” should drop materially with explainability.

4) **Memory growth**  
Duplicate writes for multi-cardinality predicates should not grow node count (corroborate-by-default).

---

## 7. Codex Prompts

### Prompt 9: Predicate Schema Registry

**Task:** Implement predicate schema registry and integrate with conflict detection.

**Requirements:**
1. Add `this._predicateSchemas` to graph constructor; seed from `config.predicateSchemas` if present.
2. Add methods:
   - `registerPredicate(predicate, schema)`
   - `registerPredicates(map)`
   - `getPredicateSchema(predicate)`
   - `listPredicateSchemas()`
3. Add normalizer helpers (pure, deterministic) and store `claim.normalizedValue`.
4. Modify structural conflict logic to:
   - Use schema cardinality and conflictPolicy
   - Dedup by corroboration when `(subject,predicate,normalizedValue)` already exists and `dedupPolicy='corroborate'`
5. Add tests: `test/predicate-schema.test.mjs`.

---

### Prompt 10: Explainability API

**Task:** Add explainability surfaces to search() and context().

**Requirements:**
1. Add `explain` option to `search()`, `searchAll()`, `searchMany()`, `context()`.
2. When explain is enabled:
   - attach `.meta` to the returned results array
   - attach `explain` to each returned item
3. Add `explainMemory()` and `explainSupersession()` helpers.
4. Add tests: `test/explainability.test.mjs`.

---

### Prompt 11: Quarantine Lane

**Task:** Implement quarantined status and quarantine workflows.

**Requirements:**
1. Extend status enum to include `'quarantined'`.
2. Update store() conflict flow:
   - If trust-gated supersession blocks OR schema requires review → set new memory quarantined, log pending conflict
3. Update search filters:
   - default `status === 'active'`
   - add include flags for superseded/disputed/quarantined
4. Add quarantine APIs:
   - `listQuarantined()`
   - `reviewQuarantine()`
   - `quarantine()`
5. Update supabase-storage upsert to include `quarantine` field and RPC filtering support.
6. Add tests: `test/quarantine.test.mjs`.

---

## 8. Summary of Deliverables

| Feature | What ships | Key outputs |
|---|---|---|
| Predicate schema registry | cardinality + conflict policy + normalization | fewer false contradictions, better dedup/corroboration |
| Explainability API | `explain` surfaces for search/context + helpers | “why retrieved / why excluded / why superseded” |
| Quarantine lane | quarantined status + review workflow | blocked conflicts never leak into default retrieval |

**Estimated risk:** Low–Medium (touches core store()/search() paths; mitigated by opt-in explainability and backward-compatible schemas)

