# PRD: neolata-mem v0.8 — "Trustworthy Memory"

> **Goal:** Make neolata-mem the only agent memory layer with explicit belief-update semantics, trust-gated supersession, and poisoning resistance built into the data model.

> **Tagline:** "Self-healing, trustworthy memory for AI agents"

> **Version:** 0.7.0 → 0.8.0

> **Files touched:** `src/graph.mjs`, `src/index.mjs`, `src/storage.mjs`, `src/supabase-storage.mjs`, `sql/schema.sql`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature 1: Claim-Based Memory Model](#2-feature-1-claim-based-memory-model)
3. [Feature 2: Provenance & Trust Scoring](#3-feature-2-provenance--trust-scoring)
4. [Feature 3: Trust-Gated Supersession](#4-feature-3-trust-gated-supersession)
5. [Feature 4: Confidence-Scored Re-ranking](#5-feature-4-confidence-scored-re-ranking)
6. [Feature 5: Budget-Aware Context Assembly](#6-feature-5-budget-aware-context-assembly)
7. [Feature 6: consolidate() — VACUUM for Memory](#7-feature-6-consolidate--vacuum-for-memory)
8. [Migration & Backward Compatibility](#8-migration--backward-compatibility)
9. [Success Metrics & Non-Goals](#9-success-metrics--non-goals)
10. [Codex Prompts](#10-codex-prompts)

---

## 1. Architecture Overview

### Current State (v0.7.0)

```
Memory = {
  id, agent, memory (text), category, importance, tags,
  embedding, links [{id, similarity, type}],
  created_at, updated_at, event_at?,
  evolution?, accessCount?, stability?, lastReviewInterval?,
  compressed?
}
```

**What we have:**
- A-MEM auto-linking (bidirectional, similarity-based)
- Typed edges (`similar`, `supersedes`, `digest_of`, `digested_into`, `related`)
- SM-2 spaced repetition decay + biological decay
- `evolve()` — LLM-based conflict detection + supersession
- `compress()` / `autoCompress()` — extractive/LLM summarization
- Episodes, labeled clusters
- Supabase + JSON + in-memory storage backends
- 144+ tests across 18 test files

**What we're adding:**
- Memories become **claims** with subject/predicate/value decomposition
- Every memory gets a **provenance** chain and **trust score**
- Supersession is **trust-gated** — low-trust sources can't override high-trust facts
- Search gets **multi-signal re-ranking** (relevance × confidence × recency × importance)
- `context()` gets **token-budget optimization** (knapsack packing)
- `consolidate()` — one-call graph maintenance with trust-aware pruning

### Target State (v0.8.0)

```
Memory = {
  // ... all existing fields ...
  
  // NEW: Claim decomposition (optional — backward compatible)
  claim?: {
    subject: string,       // "user", "system", "project-x"
    predicate: string,     // "prefers", "budget_is", "lives_in"
    value: string,         // "dark mode", "$750", "Seattle"
    exclusive: boolean,    // true = only one value per (subject, predicate); false = multi-valued (default: true)
    scope: 'global' | 'session' | 'temporal',
    sessionId?: string,    // required when scope='session' — ties claim to a conversation
    validFrom?: string,    // ISO 8601
    validUntil?: string,   // ISO 8601 (null = still active)
  },
  
  // NEW: Provenance
  provenance: {
    source: 'user_explicit' | 'user_implicit' | 'tool_output' | 'document' | 'inference' | 'system',
    sourceId?: string,     // e.g., document ID, tool call ID
    corroboration: number, // how many independent sources confirm this (default: 1)
    trust: number,         // 0.0–1.0, computed from source + corroboration + feedback
  },
  
  // NEW: Feedback-adjusted confidence (trustworthiness signal only — not combined with importance/recency)
  confidence: number,      // 0.0–1.0, derived from trust + corroboration + feedback
  reinforcements: number,  // positive feedback count
  disputes: number,        // negative feedback count
  
  // NEW: Supersession tracking
  superseded_by?: string,  // ID of memory that replaced this one
  supersedes?: string[],   // IDs of memories this one replaced
  status: 'active' | 'superseded' | 'disputed' | 'quarantined' | 'archived',
  // 'quarantined' = blocked by trust gating, excluded from default retrieval
}
```

---

## 2. Feature 1: Claim-Based Memory Model

### What

Optionally decompose memories into structured claims: `{subject, predicate, value, scope, validity}`. This enables **structural** contradiction detection without LLM calls.

### Why

- Two memories are contradictions if they share `(subject, predicate)`, differ in `value`, the predicate is `exclusive`, and their validity windows overlap
- Scope semantics: `session`-scoped claims **override at retrieval time** (not supersede at storage); `global` and `temporal` claims supersede normally
- Validity windows enable temporal reasoning: "lived in Seattle 2019–2022" and "lives in Austin 2022–present" are NOT contradictions
- Predicate cardinality (`exclusive: true/false`) prevents false positives on multi-valued predicates like "likes", "has_skill"

### API Changes

```javascript
// New: store with claim decomposition
await mem.store('agent-1', 'User budget is $750', {
  claim: {
    subject: 'user',
    predicate: 'budget_is',
    value: '$750',
    scope: 'global',
  },
  provenance: { source: 'user_explicit' },
});

// Auto-extraction of claims (if LLM available)
await mem.store('agent-1', 'User budget is $750', {
  provenance: { source: 'user_explicit' },
  extractClaim: true, // LLM extracts subject/predicate/value
});
```

### Implementation

**In `store()` (graph.mjs):**

1. If `opts.claim` is provided, validate and attach to memory object
2. If `opts.extractClaim` is true and LLM available, call `_extractClaim(text)` → structured claim
3. If claim provided, run `_structuralConflictCheck(claim)` before embedding — O(n) scan of memories with same `(subject, predicate)`, no LLM needed
4. If structural conflict found and trust allows supersession → auto-supersede

**New private method `_extractClaim(text)`:**

```javascript
async _extractClaim(text) {
  if (!this.llm) return null;
  const prompt = `Extract a structured claim from this text.
<text>${text}</text>
Respond with JSON: {"subject":"...","predicate":"...","value":"...","scope":"global|session|temporal"}
If the text is not a clear factual claim, respond: {"none": true}`;
  // ... parse, validate ...
}
```

**New private method `_structuralConflictCheck(claim)`:**

```javascript
_structuralConflictCheck(claim) {
  if (!claim?.subject || !claim?.predicate) return [];
  // Non-exclusive predicates (multi-valued) never conflict structurally
  if (claim.exclusive === false) return [];
  const key = `${claim.subject}::${claim.predicate}`;
  const ids = this._claimIndex.get(key);
  if (!ids || ids.size === 0) return [];
  return [...ids]
    .map(id => this._byId(id))
    .filter(m => {
      if (!m || m.status === 'superseded' || m.status === 'quarantined') return false;
      if (m.claim?.value === claim.value) return false; // same value = not a conflict
      if (m.claim?.exclusive === false) return false;
      // Session-scoped claims don't supersede global claims at storage time
      if (claim.scope === 'session' && m.claim?.scope === 'global') return false;
      // Check validity window overlap
      if (!_validityOverlaps(claim, m.claim)) return false;
      return true;
    });
}
```

**New helper `_validityOverlaps(claimA, claimB)`:**

```javascript
function _validityOverlaps(a, b) {
  // If neither has validity windows, they overlap (both "always valid")
  const aFrom = a?.validFrom ? new Date(a.validFrom).getTime() : -Infinity;
  const aUntil = a?.validUntil ? new Date(a.validUntil).getTime() : Infinity;
  const bFrom = b?.validFrom ? new Date(b.validFrom).getTime() : -Infinity;
  const bUntil = b?.validUntil ? new Date(b.validUntil).getTime() : Infinity;
  return aFrom <= bUntil && bFrom <= aUntil;
}
```

**New index:** `_claimIndex: Map<string, Set<string>>` — key is `${subject}::${predicate}`, value is Set of memory IDs. Updated in `_indexMemory()` / `_deindexMemory()`.

**Exact-claim deduplication:** When a new claim has the same `(subject, predicate, value)` as an existing active memory, **do not create a new node**. Instead, call `corroborate(existingId)` on the existing memory and update its `updated_at`. Return the existing memory from `store()` with a `deduplicated: true` flag.

### Tests

- Store with claim → claim stored correctly
- Store conflicting claim (exclusive predicate) → detected without LLM
- Store same claim twice → deduplicated (corroborate existing, no new node)
- Claim with scope `session` doesn't supersede `global` at storage time
- Claims with non-overlapping validity windows → NOT a conflict
- Claims with overlapping validity windows → conflict detected
- Non-exclusive predicate (exclusive: false) → never conflicts structurally
- `extractClaim: true` → LLM called, claim attached
- Claim with scope `session` requires sessionId (validation error if missing)
- Backward compat: store without claim → works exactly as before

---

## 3. Feature 2: Provenance & Trust Scoring

### What

Every memory gets a `provenance` object tracking its origin and a computed `trust` score. Trust is a function of source reliability, corroboration, age, and feedback.

### Why

- Trust scoring enables poisoning defense (low-trust memories can't override high-trust ones)
- Corroboration provides evidence strength (3 independent sources saying the same thing > 1)
- Provenance enables audit trails ("where did this claim come from?")

### Trust Score Formula

```javascript
function computeTrust(provenance, reinforcements, disputes, ageDays) {
  const SOURCE_WEIGHTS = {
    user_explicit: 1.0,
    system: 0.95,
    tool_output: 0.85,
    user_implicit: 0.7,
    document: 0.6,
    inference: 0.5,
  };
  
  const sourceBase = SOURCE_WEIGHTS[provenance.source] || 0.5;
  const corroborationBonus = Math.min(0.2, (provenance.corroboration - 1) * 0.05);
  const feedbackSignal = reinforcements > 0 || disputes > 0
    ? (reinforcements - disputes) / (reinforcements + disputes) * 0.15
    : 0;
  const recencyPenalty = Math.max(0, Math.min(0.1, ageDays / 365 * 0.1));
  
  return Math.max(0, Math.min(1.0,
    sourceBase + corroborationBonus + feedbackSignal - recencyPenalty
  ));
}
```

### Confidence Score (trustworthiness only — decoupled from importance/recency to avoid double-counting in re-ranking)

`confidence` represents **how much we believe this memory is true**, independent of how important or recent it is. Re-ranking (Feature 4) combines confidence with separate relevance, recency, and importance signals.

```javascript
function computeConfidence(provenance, reinforcements, disputes) {
  // Confidence = trust score (already incorporates source weight, corroboration, feedback, recency penalty)
  // This is intentionally just the trust value — keeping it as a separate field enables
  // the reranker to weight trust independently from importance and freshness.
  return provenance?.trust ?? 0.5;
}
```

> **Design note:** Earlier drafts had `confidence = trust * 0.4 + strength * 0.3 + importance * 0.3`, but this double-counted importance and recency in the reranker. Keeping confidence = trust makes the four ranking signals (relevance, confidence, recency, importance) orthogonal.

### API Changes

```javascript
// Store with provenance
await mem.store('agent-1', 'User lives in Seattle', {
  provenance: { source: 'user_explicit' },
});
// → provenance.trust auto-computed to 1.0

// Reinforce (positive feedback)
await mem.reinforce(memoryId);
// → existing method, now also increments reinforcements + recomputes trust

// Dispute (negative feedback) — NEW
await mem.dispute(memoryId, { reason: 'outdated info' });
// → increments disputes, recomputes trust, may mark as 'disputed' if trust drops below threshold

// Corroborate — NEW
await mem.corroborate(memoryId);
// → increments provenance.corroboration, recomputes trust
```

### Implementation

**In `store()` (graph.mjs):**

1. Accept optional `opts.provenance` — validate source is in allowed list
2. Default provenance: `{ source: 'inference', corroboration: 1 }`
3. Compute initial trust score
4. Set `confidence = computeConfidence(mem)`
5. Set `status = 'active'`, `reinforcements = 0`, `disputes = 0`

**New method `dispute(memoryId, opts)`:**

```javascript
async dispute(memoryId, { reason } = {}) {
  const mem = this._byId(memoryId);
  if (!mem) return null;
  mem.disputes = (mem.disputes || 0) + 1;
  mem.provenance.trust = computeTrust(mem.provenance, mem.reinforcements, mem.disputes, ageDays(mem));
  mem.confidence = computeConfidence(mem);
  if (mem.provenance.trust < 0.3) mem.status = 'disputed';
  // ... persist ...
}
```

**New method `corroborate(memoryId)`:**

```javascript
async corroborate(memoryId) {
  const mem = this._byId(memoryId);
  if (!mem) return null;
  mem.provenance.corroboration = (mem.provenance.corroboration || 1) + 1;
  mem.provenance.trust = computeTrust(mem.provenance, mem.reinforcements, mem.disputes, ageDays(mem));
  mem.confidence = computeConfidence(mem);
  // ... persist ...
}
```

**Modify existing `reinforce()`:**
- Add `mem.reinforcements = (mem.reinforcements || 0) + 1`
- Recompute trust and confidence after boost

### Tests

- Store with provenance → trust computed correctly
- user_explicit trust > inference trust
- Corroborate 3x → trust increases
- Dispute below threshold → status becomes 'disputed'
- Reinforce increments reinforcements + boosts trust
- Default provenance assigned when none provided
- Confidence combines trust, strength, importance

---

## 4. Feature 3: Trust-Gated Supersession

### What

When a new memory structurally conflicts with an existing one (same subject/predicate, different value), supersession only happens if the new memory's trust is ≥ the existing memory's trust. Otherwise, the conflict is flagged for human review.

### Why

This is the poisoning defense. Without trust gating:
- An attacker can inject "User budget is $0" via a low-trust source (e.g., a scraped document)
- The contradiction engine dutifully supersedes the real budget
- The agent now operates on poisoned data

With trust gating:
- The injected memory has trust 0.6 (document source)
- The real memory has trust 1.0 (user_explicit)
- Supersession is **blocked**
- The conflict is logged to `pendingConflicts` for human review

### Precedence Rules (deterministic, no LLM needed)

```
1. Scope gate: session-scoped claims NEVER supersede global claims at storage time
   (they override at retrieval time when sessionId matches — see search() changes)
2. Validity gate: non-overlapping validity windows → not a conflict
3. Trust level: higher trust wins (supersedes lower)
4. At equal trust + same scope: recency wins (newer supersedes older)
5. Explicit user correction (source='user_explicit') always supersedes any non-user source
```

### What happens when trust gating blocks supersession

When a low-trust memory conflicts with a high-trust one, the new memory is **quarantined** — not just logged:

- `status: 'quarantined'` — excluded from default retrieval (same as superseded)
- A pending conflict is created for human review
- This prevents poisoned memories from appearing in search/context results
- Resolution options: `supersede` (override), `reject` (archive), `keep_both` (both active)

### API Changes

```javascript
// Store conflicting claim — auto-supersession if trust allows
const result = await mem.store('agent-1', 'User budget is $1000', {
  claim: { subject: 'user', predicate: 'budget_is', value: '$1000', scope: 'global' },
  provenance: { source: 'user_explicit' },
});
// result.superseded = ['mem_abc...'] (the old $750 memory)

// If trust is insufficient:
// result.pendingConflict = { existingId: 'mem_abc', reason: 'trust_insufficient', existingTrust: 1.0, newTrust: 0.6 }

// List pending conflicts — NEW
const pending = await mem.pendingConflicts();
// [{newId, existingId, reason, newTrust, existingTrust, newClaim, existingClaim}]

// Resolve a pending conflict manually — NEW  
await mem.resolveConflict(pendingId, { action: 'supersede' | 'reject' | 'keep_both' });

// List all active contradictions (first-class conflicts view) — NEW
const all = await mem.conflicts({ subject: 'user', includeResolved: false });
// [{newId, existingId, newClaim, existingClaim, newTrust, existingTrust, status}]
```

### Implementation

**Modify `store()` flow (after structural conflict check):**

```javascript
// After _structuralConflictCheck returns conflicts:
if (conflicts.length > 0) {
  const newTrust = computeTrust(provenance, 0, 0, 0);
  for (const existing of conflicts) {
    const existingTrust = existing.provenance?.trust ?? 0.5;
    
    if (newTrust >= existingTrust) {
      // Supersede: mark old as superseded, link new → old
      existing.status = 'superseded';
      existing.superseded_by = newMem.id;
      newMem.supersedes = newMem.supersedes || [];
      newMem.supersedes.push(existing.id);
      newMem.links.push({ id: existing.id, similarity: 1.0, type: 'supersedes' });
    } else {
      // Trust insufficient — quarantine the new memory + log pending conflict
      newMem.status = 'quarantined';
      this._pendingConflicts.push({
        id: this.storage.genId(),
        newId: newMem.id,
        existingId: existing.id,
        newTrust,
        existingTrust,
        newClaim: newMem.claim,
        existingClaim: existing.claim,
        created_at: new Date().toISOString(),
      });
    }
  }
}
```

**New field on MemoryGraph:** `this._pendingConflicts = []` (persisted via storage)

**Search defaults to `status === 'active'` only:**

```javascript
// In search(), add filter (after agent filter):
if (!includeAll) {
  candidates = candidates.filter(m => !m.status || m.status === 'active');
}
```

**New options:** `search(agent, query, { includeAll: false, statusFilter: ['active'] })`
- `includeAll: true` → returns all statuses (superseded, quarantined, disputed, archived)
- `statusFilter: ['active', 'disputed']` → fine-grained control
- Default: only `active` memories returned

### Tests

- High-trust supersedes low-trust → old marked superseded
- Low-trust cannot supersede high-trust → new memory quarantined + pending conflict created
- Equal trust, newer wins → supersession
- Session-scoped claim does NOT supersede global claim (even with higher trust)
- Non-overlapping validity windows → no conflict
- Non-exclusive predicate → no conflict
- Exact-value duplicate → corroborate existing, no new node
- pendingConflicts() returns unresolved conflicts
- resolveConflict('supersede') → quarantined memory activated, existing superseded
- resolveConflict('reject') → quarantined memory archived
- resolveConflict('keep_both') → both activated, conflict removed
- Search returns only active by default (excludes superseded, quarantined, disputed)
- Search with includeAll: true → includes all statuses
- Search with statusFilter: ['active', 'disputed'] → includes both
- Evolve still works (backward compat, uses LLM path when no claims)

---

## 5. Feature 4: Confidence-Scored Re-ranking

### What

After initial retrieval (vector similarity + keyword), apply a multi-signal re-ranking pass that scores by `relevance × confidence × recency × importance`.

### Why

Vector similarity alone returns "similar text" not "best answer." A memory that's similar but superseded, low-trust, or ancient is worse than a slightly less similar but highly trusted, recent memory.

### Scoring Formula

```javascript
function rerank(results, query) {
  const now = Date.now();
  return results.map(r => {
    const relevance = r.score;                              // vector similarity (0-1)
    const confidence = r.confidence ?? 0.5;                  // trust × strength × importance
    const recency = Math.exp(-0.01 * daysSince(r.updated_at)); // exponential recency (0-1)
    const importanceFactor = r.importance ?? 0.5;
    
    r.compositeScore = (
      relevance   * 0.40 +
      confidence  * 0.25 +
      recency     * 0.20 +
      importanceFactor * 0.15
    );
    return r;
  }).sort((a, b) => b.compositeScore - a.compositeScore);
}
```

### API Changes

```javascript
// Default: re-ranking enabled
const results = await mem.search('agent-1', 'budget', { rerank: true });
// results[0].compositeScore = 0.87
// results[0].rankingSignals = { relevance: 0.92, confidence: 0.85, recency: 0.78, importance: 0.9 }

// Opt out (raw vector similarity only)
const raw = await mem.search('agent-1', 'budget', { rerank: false });

// Custom weights
const custom = await mem.search('agent-1', 'budget', {
  rerank: { relevance: 0.5, confidence: 0.3, recency: 0.1, importance: 0.1 },
});
```

### Implementation

**In `search()`, after the existing sort-by-similarity, add re-ranking pass:**

```javascript
if (rerank !== false) {
  const weights = typeof rerank === 'object' ? rerank : { relevance: 0.4, confidence: 0.25, recency: 0.2, importance: 0.15 };
  results = this._rerank(results, weights);
}
```

**New private method `_rerank(results, weights)`:**

Returns results with `compositeScore` and `rankingSignals` attached.

### Tests

- Re-ranked results differ from raw similarity order
- High-confidence memory outranks higher-similarity but low-confidence memory
- Custom weights shift ranking appropriately
- `rerank: false` preserves raw order
- Backward compat: default behavior improves without breaking existing callers

---

## 6. Feature 5: Budget-Aware Context Assembly

### What

`context()` gets a `maxTokens` option. Instead of returning top-N memories, it solves a knapsack problem: maximize total information value within a token budget.

### Why

Agent context windows are finite. Returning 15 memories that consume 4000 tokens when the agent has 2000 tokens available wastes half the context. Budget-aware assembly returns the **highest-value memories that fit**.

### Token Estimation

```javascript
function estimateTokens(text) {
  // Fast heuristic: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}
```

### API Changes

```javascript
// Budget-aware context
const ctx = await mem.context('agent-1', 'project status', {
  maxTokens: 2000,      // NEW: token budget
  maxMemories: 30,      // candidate pool (search this many, then pack)
});
// ctx.context = "## Relevant Memory Context ..."
// ctx.tokenEstimate = 1847
// ctx.included = 12      // how many fit
// ctx.excluded = 3       // how many dropped due to budget
// ctx.excludedReasons = [{id, reason: 'budget', value: 0.34}]
```

### Implementation

**Modify `context()` in graph.mjs:**

1. Search with larger `limit` (e.g., `maxMemories * 2` or 30)
2. Expand 1-hop as before
3. Score all candidates with `computeConfidence()` or `compositeScore`
4. If `maxTokens` specified, run greedy knapsack:
   ```javascript
   // Sort by value/token ratio (best value density first)
   candidates.sort((a, b) => (b.compositeScore / estimateTokens(b.memory)) - (a.compositeScore / estimateTokens(a.memory)));
   let budgetLeft = maxTokens - overhead; // overhead = headers, formatting
   const included = [];
   const excluded = [];
   for (const c of candidates) {
     const tokens = estimateTokens(c.memory);
     if (tokens <= budgetLeft) {
       included.push(c);
       budgetLeft -= tokens;
     } else {
       excluded.push({ id: c.id, reason: 'budget', value: c.compositeScore });
     }
   }
   ```
5. Format included memories as before
6. Return with `tokenEstimate`, `included`, `excluded`, `excludedReasons`

### Tests

- `maxTokens: 500` → returns fewer memories than unlimited
- High-value short memories preferred over low-value long ones
- `excludedReasons` populated correctly
- `tokenEstimate` roughly accurate
- Without `maxTokens` → behaves exactly as v0.7

---

## 7. Feature 6: consolidate() — VACUUM for Memory

### What

A single method that performs the full memory maintenance lifecycle:

1. **Deduplicate** — find near-identical memories (similarity > 0.95), merge
2. **Resolve contradictions** — structural conflict check on all claims, auto-supersede where trust allows
3. **Corroborate** — find memories that say the same thing from different sources, boost confidence
4. **Compress stale clusters** — run autoCompress on old, low-activity clusters
5. **Prune dead memories** — remove superseded + decayed-below-threshold + zero-access

### API

```javascript
const report = await mem.consolidate({
  dryRun: false,        // true = report only, no mutations
  dedupThreshold: 0.95, // similarity threshold for dedup
  compressAge: 30,      // days before cluster compression
  pruneSuperseded: true, // remove superseded memories older than X days
  pruneAge: 90,         // days before pruning superseded
});

// report:
{
  deduplicated: 3,       // near-identical pairs merged
  contradictions: {
    resolved: 2,         // auto-superseded (trust allowed)
    pending: 1,          // flagged for human review
  },
  corroborated: 5,       // confidence boosted on corroborated facts
  compressed: {
    clusters: 2,
    sourceMemories: 8,
  },
  pruned: {
    superseded: 4,       // old superseded memories removed
    decayed: 6,          // below threshold
    disputed: 1,         // trust too low
  },
  before: { total: 250, active: 230 },
  after: { total: 228, active: 220 },
  duration_ms: 1200,
}
```

### Implementation

**New method `consolidate(opts)` in graph.mjs:**

```javascript
async consolidate({
  dryRun = false,
  dedupThreshold = 0.95,
  compressAge = 30,
  pruneSuperseded = true,
  pruneAge = 90,
  method = 'extractive',
} = {}) {
  await this.init();
  const report = { /* ... */ };
  const start = Date.now();

  // Phase 1: Dedup
  // For each active memory, find others with similarity > threshold
  // Keep the one with higher trust, merge tags/links from the other
  
  // Phase 2: Structural contradiction check
  // Build claim index, find (subject, predicate) collisions
  // Apply trust-gated supersession
  
  // Phase 3: Corroboration
  // Find memories with similarity > 0.9 from different sources
  // Increment corroboration count on the higher-trust one
  
  // Phase 4: Compress
  // Find clusters where all members are older than compressAge days
  // Run autoCompress on them
  
  // Phase 5: Prune
  // Remove: superseded memories older than pruneAge days
  //         memories with status 'disputed' and trust < 0.2
  //         memories below deleteThreshold (existing decay logic)
  
  report.duration_ms = Date.now() - start;
  return report;
}
```

### Performance Constraints

- **O(n²) dedup + corroboration** is acceptable for ≤1000 active memories (typical agent workload)
- Add `maxMemories` option (default: 1000) — if more active memories exist, sample by lowest-confidence first
- Compression phase limited to 5 clusters per run (already in implementation)
- Document: "For graphs >5000 memories, run consolidate on a schedule with `maxMemories` batching"
- Future: approximate nearest neighbor for dedup (v0.9)

### Tests

- consolidate() with all defaults → runs all phases
- dryRun: true → report generated but no mutations
- Dedup merges near-identical memories
- Contradictions auto-resolved where trust allows
- Corroboration boosts confidence
- Old superseded memories pruned
- Report counts are accurate

---

## 8. Migration & Backward Compatibility

### Incremental Persistence Rule

**Every mutation to an existing memory must be persisted in incremental backends.** This includes:
- Marking as `superseded` (trust-gated supersession)
- Marking as `quarantined` (blocked supersession)
- Updating `superseded_by`, `supersedes`, `status`, `disputes`, `reinforcements`, `provenance.trust`, `confidence`
- Merging tags/links during dedup
- Any field change during `consolidate()`

In all Codex prompts, when mutating an existing memory, always include: `if (this.storage.incremental) await this.storage.upsert(existing);`

### Principle: 100% backward compatible

All new fields are **optional**. Existing memories without `claim`, `provenance`, `confidence`, `status` work exactly as before:

- `provenance` defaults to `{ source: 'inference', corroboration: 1, trust: 0.5 }`
- `confidence` defaults to `0.5`
- `status` defaults to `'active'`
- `claim` defaults to `undefined` (no structural conflict checking)
- Re-ranking uses defaults that preserve existing behavior as closely as possible
- `search()` without `rerank` option uses the new re-ranking (improved default)
- `context()` without `maxTokens` behaves exactly as v0.7

### Supabase Migration

```sql
-- v0.8.0 migration
ALTER TABLE memories ADD COLUMN IF NOT EXISTS claim jsonb;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS provenance jsonb DEFAULT '{"source":"inference","corroboration":1,"trust":0.5}';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence float DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcements integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS disputes integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes text[];

-- Claim index for structural conflict detection
CREATE INDEX IF NOT EXISTS idx_memories_claim_subject_predicate 
  ON memories ((claim->>'subject'), (claim->>'predicate')) 
  WHERE claim IS NOT NULL;

-- Status index (active, superseded, quarantined, disputed, archived)
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);

-- Partial index for active-only queries (most common path)
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories (agent, created_at) WHERE status = 'active';

-- Pending conflicts table
CREATE TABLE IF NOT EXISTS pending_conflicts (
  id text PRIMARY KEY,
  new_id text NOT NULL REFERENCES memories(id),
  existing_id text NOT NULL REFERENCES memories(id),
  new_trust float NOT NULL,
  existing_trust float NOT NULL,
  new_claim jsonb,
  existing_claim jsonb,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolution text -- 'supersede', 'reject', 'keep_both'
);
```

---

## 9. Success Metrics & Non-Goals

### Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Context drift error rate | <1% of retrieval contexts contain superseded facts | Integration test: search never returns superseded unless opted in |
| Contradiction exposure rate | 0% of default retrieval contexts contain mutually exclusive active claims | Test: conflicting claims auto-supersede or quarantine |
| Poisoning resistance | 0% of low-trust overrides succeed without manual resolution | Test: trust-gated supersession blocks all low-trust → high-trust overrides |
| Retrieval signal orthogonality | 4 independent signals in reranker (relevance, confidence, recency, importance) | Code review: no double-counting |
| Context token efficiency | -30% waste vs top-K baseline | Benchmark: budget-aware context vs unlimited on same corpus |
| Memory growth rate | Bounded with periodic consolidate() | Test: consolidate reduces total count on bloated graph |
| Backward compatibility | 0 existing test regressions | CI: all 144+ existing tests pass unchanged |

### Non-Goals (v0.8 scope protection)

- **Not building connectors/loaders** — v0.8 is about intelligence, not ingestion
- **Not guaranteeing optimal knapsack** — greedy by value-density is good enough
- **Not doing deep knowledge graph reasoning** — typed edges, not OWL/RDF
- **Not building a UI** — conflicts/consolidate are API-first; CLI/UI is future work
- **Not handling cross-agent trust** — trust is per-memory, not per-agent-relationship
- **Not supporting custom trust formulas** — SOURCE_WEIGHTS are hardcoded; pluggable in v0.9

---

## 10. Codex Prompts

### Prompt 1: Claim-Based Memory Model — Data Model + Index

**Context:** You are modifying `neolata-mem`, a graph-native memory engine for AI agents. The codebase is in `src/graph.mjs` (2037 lines, ES module). All tests are in `test/` using Vitest.

**Task:** Add claim-based memory support to the data model.

**Requirements:**

1. **In `src/graph.mjs`:**
   - Add a `_claimIndex: Map<string, Set<string>>` field in the constructor, alongside `_idIndex` and `_tokenIndex`
   - Key format: `${subject}::${predicate}` → Set of memory IDs
   - Update `_indexMemory(mem)` to index claims: if `mem.claim?.subject && mem.claim?.predicate`, add to `_claimIndex`
   - Update `_deindexMemory(mem)` to remove from `_claimIndex`
   - Update `_rebuildIndexes()` to rebuild `_claimIndex`
   - Add module-level helper `_validityOverlaps(claimA, claimB)`:
     ```javascript
     function _validityOverlaps(a, b) {
       const aFrom = a?.validFrom ? new Date(a.validFrom).getTime() : -Infinity;
       const aUntil = a?.validUntil ? new Date(a.validUntil).getTime() : Infinity;
       const bFrom = b?.validFrom ? new Date(b.validFrom).getTime() : -Infinity;
       const bUntil = b?.validUntil ? new Date(b.validUntil).getTime() : Infinity;
       return aFrom <= bUntil && bFrom <= aUntil;
     }
     ```
   - Add new private method `_structuralConflictCheck(claim)`:
     ```javascript
     _structuralConflictCheck(claim) {
       if (!claim?.subject || !claim?.predicate) return [];
       if (claim.exclusive === false) return []; // multi-valued predicates never conflict
       const key = `${claim.subject}::${claim.predicate}`;
       const ids = this._claimIndex.get(key);
       if (!ids || ids.size === 0) return [];
       return [...ids]
         .map(id => this._byId(id))
         .filter(m => {
           if (!m || m.status === 'superseded' || m.status === 'quarantined') return false;
           if (m.claim?.value === claim.value) return false; // same value = dedup, not conflict
           if (m.claim?.exclusive === false) return false;
           if (claim.scope === 'session' && m.claim?.scope === 'global') return false; // session doesn't supersede global
           if (!_validityOverlaps(claim, m.claim)) return false; // non-overlapping = not a conflict
           return true;
         });
     }
     ```
   - Add new private method `_findExactClaimDuplicate(claim)`:
     ```javascript
     _findExactClaimDuplicate(claim) {
       if (!claim?.subject || !claim?.predicate) return null;
       const key = `${claim.subject}::${claim.predicate}`;
       const ids = this._claimIndex.get(key);
       if (!ids) return null;
       for (const id of ids) {
         const m = this._byId(id);
         if (m && m.status === 'active' && m.claim?.value === claim.value) return m;
       }
       return null;
     }
     ```
   - In `store()`, **before creating a new memory**: if claim is provided, check for exact duplicate via `_findExactClaimDuplicate()`. If found, call `corroborate(existing.id)`, update `existing.updated_at`, and return existing memory with `{ deduplicated: true }` — do NOT create a new node.
   - In `store()`, accept `opts.claim` (object with subject, predicate, value, exclusive?, scope, sessionId?, validFrom?, validUntil?) and `opts.provenance` (object with source, sourceId?)
   - Validate claim fields: subject and predicate must be non-empty strings (max 100 chars each), value must be string (max 1000 chars), scope must be one of 'global', 'session', 'temporal'
   - Validate: if `scope === 'session'`, `sessionId` must be a non-empty string (throw if missing)
   - Default `exclusive` to `true` if not specified
   - Attach `claim` to the new memory object if provided
   - Add default fields to new memory: `status: 'active'`, `reinforcements: 0`, `disputes: 0`
   - Add default provenance: `provenance: opts.provenance ? { source: opts.provenance.source || 'inference', sourceId: opts.provenance.sourceId, corroboration: 1, trust: computeTrust(...) } : { source: 'inference', corroboration: 1, trust: 0.5 }`

2. **Add helper function `computeTrust(provenance, reinforcements, disputes, ageDays)` as a module-level function (exported):**
   ```javascript
   const SOURCE_WEIGHTS = {
     user_explicit: 1.0, system: 0.95, tool_output: 0.85,
     user_implicit: 0.7, document: 0.6, inference: 0.5,
   };
   export function computeTrust(provenance, reinforcements = 0, disputes = 0, ageDays = 0) {
     const sourceBase = SOURCE_WEIGHTS[provenance?.source] || 0.5;
     const corroborationBonus = Math.min(0.2, ((provenance?.corroboration || 1) - 1) * 0.05);
     const feedbackTotal = reinforcements + disputes;
     const feedbackSignal = feedbackTotal > 0 ? ((reinforcements - disputes) / feedbackTotal) * 0.15 : 0;
     const recencyPenalty = Math.max(0, Math.min(0.1, ageDays / 365 * 0.1));
     return Math.max(0, Math.min(1.0, sourceBase + corroborationBonus + feedbackSignal - recencyPenalty));
   }
   ```

3. **Add `computeConfidence(mem)` module-level function (exported):**
   ```javascript
   export function computeConfidence(mem) {
     // Confidence = trustworthiness only (decoupled from importance/recency to avoid double-counting in reranker)
     return +(mem.provenance?.trust ?? 0.5).toFixed(4);
   }
   ```

4. **In `src/index.mjs`:** Add `computeTrust, computeConfidence` to the re-export from `./graph.mjs`

5. **Create `test/claims.test.mjs`:**
   - Test: store with claim → memory has claim field
   - Test: store with claim → claim indexed in _claimIndex
   - Test: _structuralConflictCheck finds conflicting exclusive claims
   - Test: _structuralConflictCheck ignores same-value claims (not a conflict)
   - Test: _structuralConflictCheck ignores superseded/quarantined memories
   - Test: _structuralConflictCheck ignores non-exclusive predicates (exclusive: false)
   - Test: _structuralConflictCheck ignores non-overlapping validity windows
   - Test: _structuralConflictCheck detects overlapping validity windows
   - Test: _structuralConflictCheck: session-scoped claim does not conflict with global
   - Test: store same (subject, predicate, value) → dedup (corroborate existing, no new node)
   - Test: store without claim → backward compatible, no claim field
   - Test: claim validation (missing subject/predicate → error)
   - Test: claim with scope='session' but no sessionId → validation error
   - Test: provenance defaults applied when not specified
   - Test: computeTrust with user_explicit → 1.0
   - Test: computeTrust with inference → 0.5
   - Test: computeTrust with corroboration bonus
   - Test: computeTrust with disputes → reduced trust
   - Test: computeConfidence equals trust score (no double-counting)
   - Test: deindex removes from _claimIndex
   - Test: rebuildIndexes rebuilds _claimIndex
   - Test: default exclusive: true when not specified
   - Use existing test helpers: `fakeEmbeddings`, `createTestGraph` pattern from `test/graph.test.mjs`

**Do NOT modify any existing test files. Do NOT change the behavior of any existing method when called without the new optional parameters.**

---

### Prompt 2: Trust-Gated Supersession in store()

**Context:** Prompt 1 has been applied. `store()` now accepts `opts.claim` and `opts.provenance`. `_structuralConflictCheck()` exists. `computeTrust()` and `computeConfidence()` exist.

**Task:** Wire trust-gated supersession into `store()`.

**Requirements:**

1. **In `src/graph.mjs`, modify `store()`:**
   - After creating the new memory object (after `const newMem = { ... }`), before pushing to `this.memories`:
   - If `newMem.claim` is set, call `this._structuralConflictCheck(newMem.claim)`
   - For each conflicting existing memory:
     - Compute new memory's trust: `computeTrust(newMem.provenance, 0, 0, 0)`
     - Get existing memory's trust: `existing.provenance?.trust ?? 0.5`
     - **If newTrust >= existingTrust:**
       - Set `existing.status = 'superseded'`
       - Set `existing.superseded_by = newMem.id`
       - Set `newMem.supersedes = newMem.supersedes || []; newMem.supersedes.push(existing.id)`
       - Add link: `newMem.links.push({ id: existing.id, similarity: 1.0, type: 'supersedes' })`
       - Emit event: `this.emit('supersede', { newId: newMem.id, oldId: existing.id, reason: 'trust_gated' })`
     - **If newTrust < existingTrust:**
       - Set `newMem.status = 'quarantined'` (excluded from default retrieval)
       - Add to `this._pendingConflicts` array: `{ id: this.storage.genId(), newId: newMem.id, existingId: existing.id, newTrust, existingTrust, newClaim: newMem.claim, existingClaim: existing.claim, created_at: new Date().toISOString() }`
       - Emit event: `this.emit('conflict:pending', { newId: newMem.id, existingId: existing.id, newTrust, existingTrust })`

2. **Add `this._pendingConflicts = []` in constructor.**

3. **Add pending conflicts persistence:**
   - In storage backends (jsonStorage, memoryStorage), add `loadPendingConflicts()` / `savePendingConflicts()` methods following the same pattern as episodes/clusters
   - JSON storage: file `pending-conflicts.json`
   - Memory storage: in-memory array
   - Add `_initPendingConflicts()` / `_savePendingConflicts()` private methods on MemoryGraph

4. **Add public methods:**
   ```javascript
   async pendingConflicts() {
     await this._initPendingConflicts();
     return this._pendingConflicts.filter(c => !c.resolved_at);
   }

   async resolveConflict(conflictId, { action }) {
     await this._initPendingConflicts();
     const conflict = this._pendingConflicts.find(c => c.id === conflictId);
     if (!conflict) throw new Error(`Conflict not found: ${conflictId}`);
     if (conflict.resolved_at) throw new Error('Conflict already resolved');
     
     if (action === 'supersede') {
       const existing = this._byId(conflict.existingId);
       const newMem = this._byId(conflict.newId);
       if (existing && newMem) {
         existing.status = 'superseded';
         existing.superseded_by = conflict.newId;
         newMem.supersedes = newMem.supersedes || [];
         newMem.supersedes.push(conflict.existingId);
         newMem.links.push({ id: conflict.existingId, similarity: 1.0, type: 'supersedes' });
         // persist both
       }
     } else if (action === 'reject') {
       const newMem = this._byId(conflict.newId);
       if (newMem) {
         // Archive the rejected new memory
         const archive = await this.storage.loadArchive();
         archive.push({ ...newMem, embedding: undefined, archived_at: new Date().toISOString(), archived_reason: 'Conflict rejected' });
         await this.storage.saveArchive(archive);
         this._deindexMemory(newMem);
         this.memories = this.memories.filter(m => m.id !== newMem.id);
         if (this.storage.incremental) await this.storage.remove(newMem.id);
       }
     }
     // action === 'keep_both' → no mutations, just resolve
     
     conflict.resolved_at = new Date().toISOString();
     conflict.resolution = action;
     await this._savePendingConflicts();
     this.emit('conflict:resolved', { id: conflictId, action });
     return { resolved: true, action };
   }
   ```

5. **Modify `search()` to filter by status (default: active only):**
   - Add `includeAll` option (default: false) and `statusFilter` option (default: `['active']`)
   - After agent filter, add:
     ```javascript
     if (!includeAll) {
       const allowed = new Set(statusFilter || ['active']);
       candidates = candidates.filter(m => !m.status || allowed.has(m.status));
     }
     ```
   - Apply same filter in `searchAll()` and `searchMany()`
   - Add session-aware override for `search()`: if `opts.sessionId` is provided, also include session-scoped claims where `claim.sessionId === opts.sessionId` (these override global at retrieval time)

6. **Add `conflicts(opts)` public method:**
   ```javascript
   async conflicts({ subject, predicate, includeResolved = false } = {}) {
     await this._initPendingConflicts();
     let results = this._pendingConflicts;
     if (!includeResolved) results = results.filter(c => !c.resolved_at);
     if (subject) results = results.filter(c => c.newClaim?.subject === subject || c.existingClaim?.subject === subject);
     if (predicate) results = results.filter(c => c.newClaim?.predicate === predicate || c.existingClaim?.predicate === predicate);
     return results;
   }
   ```

7. **Create `test/trust-gating.test.mjs`:**
   - Test: store conflicting claim with higher trust → old memory superseded
   - Test: store conflicting claim with lower trust → new memory quarantined + pending conflict created
   - Test: store conflicting claim with equal trust → supersession (newer wins)
   - Test: search returns only active by default (excludes superseded, quarantined, disputed)
   - Test: search with includeAll: true → includes all statuses
   - Test: search with statusFilter: ['active', 'disputed'] → includes both
   - Test: search with sessionId overrides with matching session-scoped claims
   - Test: pendingConflicts() returns unresolved conflicts
   - Test: conflicts({ subject: 'user' }) filters by subject
   - Test: resolveConflict('supersede') → quarantined memory activated, existing superseded
   - Test: resolveConflict('reject') → quarantined memory archived
   - Test: resolveConflict('keep_both') → both activated, conflict removed
   - Test: supersede event emitted
   - Test: conflict:pending event emitted
   - Test: existing evolve() still works (backward compat)
   - Test: store without claims → no conflict checking (backward compat)
   - Test: exact-value duplicate → corroborate, no new node

**Do NOT modify existing test files.**

---

### Prompt 3: dispute() and corroborate() Methods

**Context:** Prompts 1-2 applied. Memories have provenance, trust, confidence, status fields. Trust-gated supersession works.

**Task:** Add `dispute()` and `corroborate()` methods.

**Requirements:**

1. **In `src/graph.mjs`:**

   **Add `dispute(memoryId, opts)` method** (in the CONFLICT RESOLUTION section, after `evolve()`):
   ```javascript
   async dispute(memoryId, { reason } = {}) {
     await this.init();
     const mem = this._byId(memoryId);
     if (!mem) return null;
     
     mem.disputes = (mem.disputes || 0) + 1;
     const ageDays = (Date.now() - new Date(mem.created_at).getTime()) / (1000 * 60 * 60 * 24);
     if (!mem.provenance) mem.provenance = { source: 'inference', corroboration: 1 };
     mem.provenance.trust = computeTrust(mem.provenance, mem.reinforcements || 0, mem.disputes, ageDays);
     mem.confidence = computeConfidence(mem);
     
     // Mark as disputed if trust drops below 0.3
     if (mem.provenance.trust < 0.3 && mem.status === 'active') {
       mem.status = 'disputed';
     }
     
     mem.updated_at = new Date().toISOString();
     
     if (this.storage.incremental) await this.storage.upsert(mem);
     else await this.save();
     
     this.emit('dispute', { id: memoryId, disputes: mem.disputes, trust: mem.provenance.trust, status: mem.status, reason });
     return {
       id: memoryId, disputes: mem.disputes, trust: +mem.provenance.trust.toFixed(4),
       confidence: mem.confidence, status: mem.status,
     };
   }
   ```

   **Add `corroborate(memoryId)` method:**
   ```javascript
   async corroborate(memoryId) {
     await this.init();
     const mem = this._byId(memoryId);
     if (!mem) return null;
     
     if (!mem.provenance) mem.provenance = { source: 'inference', corroboration: 1 };
     mem.provenance.corroboration = (mem.provenance.corroboration || 1) + 1;
     
     const ageDays = (Date.now() - new Date(mem.created_at).getTime()) / (1000 * 60 * 60 * 24);
     mem.provenance.trust = computeTrust(mem.provenance, mem.reinforcements || 0, mem.disputes || 0, ageDays);
     mem.confidence = computeConfidence(mem);
     
     mem.updated_at = new Date().toISOString();
     
     if (this.storage.incremental) await this.storage.upsert(mem);
     else await this.save();
     
     this.emit('corroborate', { id: memoryId, corroboration: mem.provenance.corroboration, trust: mem.provenance.trust });
     return {
       id: memoryId, corroboration: mem.provenance.corroboration,
       trust: +mem.provenance.trust.toFixed(4), confidence: mem.confidence,
     };
   }
   ```

   **Modify existing `reinforce()` method:**
   - After existing importance boost logic, add:
     ```javascript
     mem.reinforcements = (mem.reinforcements || 0) + 1;
     // Recompute trust + confidence
     const ageDays = (Date.now() - new Date(mem.created_at).getTime()) / (1000 * 60 * 60 * 24);
     if (!mem.provenance) mem.provenance = { source: 'inference', corroboration: 1 };
     mem.provenance.trust = computeTrust(mem.provenance, mem.reinforcements, mem.disputes || 0, ageDays);
     mem.confidence = computeConfidence(mem);
     ```
   - Add `reinforcements` and `confidence` to the return object

2. **Create `test/trust-feedback.test.mjs`:**
   - Test: dispute() increments disputes count
   - Test: dispute() recomputes trust (lower)
   - Test: dispute() below threshold → status becomes 'disputed'
   - Test: dispute() on non-existent memory → returns null
   - Test: corroborate() increments corroboration count
   - Test: corroborate() recomputes trust (higher)
   - Test: corroborate() on non-existent memory → returns null
   - Test: reinforce() now increments reinforcements
   - Test: reinforce() recomputes confidence
   - Test: multiple disputes drive trust below threshold
   - Test: dispute + corroborate interactions balance out

**Do NOT modify existing test files.**

---

### Prompt 4: Confidence-Scored Re-ranking in search()

**Context:** Prompts 1-3 applied. Memories have `confidence` field. `computeConfidence()` exists.

**Task:** Add multi-signal re-ranking to `search()`.

**Requirements:**

1. **In `src/graph.mjs`:**

   **Add `_rerank(results, weights)` private method:**
   ```javascript
   _rerank(results, weights = {}) {
     const w = {
       relevance: weights.relevance ?? 0.40,
       confidence: weights.confidence ?? 0.25,
       recency: weights.recency ?? 0.20,
       importance: weights.importance ?? 0.15,
     };
     const now = Date.now();
     
     for (const r of results) {
       const recencyDays = (now - new Date(r.updated_at || r.created_at).getTime()) / (1000 * 60 * 60 * 24);
       const recencyScore = Math.exp(-0.01 * recencyDays);
       
       r.rankingSignals = {
         relevance: r.score,
         confidence: r.confidence ?? 0.5,
         recency: +recencyScore.toFixed(4),
         importance: r.importance ?? 0.5,
       };
       
       r.compositeScore = +(
         r.rankingSignals.relevance * w.relevance +
         r.rankingSignals.confidence * w.confidence +
         r.rankingSignals.recency * w.recency +
         r.rankingSignals.importance * w.importance
       ).toFixed(4);
     }
     
     return results.sort((a, b) => b.compositeScore - a.compositeScore);
   }
   ```

   **Modify `search()`:**
   - Add `rerank` to destructured options: `{ limit = 10, minSimilarity = 0, before, after, rerank = true, includeAll = false, statusFilter }`
   - Status filtering is already applied from Prompt 2. After that, add re-ranking:
     ```javascript
     // Re-rank with orthogonal signals (confidence = trust only, no double-counting)
     if (rerank !== false && results.length > 0) {
       const weights = typeof rerank === 'object' ? rerank : undefined;
       results = this._rerank(results, weights);
       results = results.slice(0, limit);
     }
     ```
   - Ensure `confidence` is included in result objects (it's the trust score — orthogonal to importance and recency in the reranker)

   **Modify `searchMany()`:**
   - Add `rerank`, `includeAll`, and `statusFilter` options
   - Apply same status filtering + re-ranking per query

2. **Create `test/reranking.test.mjs`:**
   - Use `createTestGraph` pattern from existing tests
   - Store 5 memories with different provenance sources (different trust levels), different ages, and different importance
   - Test: default re-ranking reorders results (high-confidence memory ranks above higher-similarity but low-confidence)
   - Test: compositeScore and rankingSignals present on results
   - Test: rerank: false → results sorted by raw similarity
   - Test: custom weights shift ranking (e.g., all weight on recency)
   - Test: superseded memories filtered by default
   - Test: includeAll: true includes all statuses
   - Test: searchMany with rerank works per-query

**Do NOT modify existing test files.**

---

### Prompt 5: Budget-Aware Context Assembly

**Context:** Prompts 1-4 applied. Re-ranking produces `compositeScore` on results. `search()` supports `rerank`.

**Task:** Add token-budget optimization to `context()`.

**Requirements:**

1. **In `src/graph.mjs`:**

   **Add module-level function `estimateTokens(text)` (exported):**
   ```javascript
   export function estimateTokens(text) {
     return Math.ceil((text || '').length / 4);
   }
   ```

   **Modify `context()`:**
   - Add `maxTokens` to options: `{ maxMemories = 15, before, after, maxTokens }`
   - If `maxTokens` is specified:
     - Search with `limit: maxMemories * 2` (larger candidate pool)
     - After hop-expansion and dedup, compute `compositeScore` for all candidates using `_rerank()`
     - Estimate formatting overhead: `const overhead = estimateTokens('## Relevant Memory Context\n### Category\n- ') * 10;` (rough)
     - Run greedy knapsack by value-density (compositeScore / tokens):
       ```javascript
       let budgetLeft = maxTokens - overhead;
       const included = [];
       const excluded = [];
       // Sort by value density
       const sorted = [...contextMems].sort((a, b) => 
         (b.compositeScore || b.score || 0) / Math.max(1, estimateTokens(b.memory)) -
         (a.compositeScore || a.score || 0) / Math.max(1, estimateTokens(a.memory))
       );
       for (const c of sorted) {
         const tokens = estimateTokens(c.memory);
         if (tokens <= budgetLeft) {
           included.push(c);
           budgetLeft -= tokens;
         } else {
           excluded.push({ id: c.id, reason: 'budget', value: c.compositeScore || c.score || 0 });
         }
       }
       ```
     - Use `included` instead of `top` for formatting
     - Add to return: `tokenEstimate`, `included: included.length`, `excluded: excluded.length`, `excludedReasons: excluded`
   - If `maxTokens` NOT specified: behave exactly as before (backward compat)

2. **Add `estimateTokens` to re-exports in `src/index.mjs`**

3. **Create `test/budget-context.test.mjs`:**
   - Store 10 memories of varying lengths (some short facts, some long paragraphs)
   - Test: context with maxTokens: 200 → fewer memories than unlimited
   - Test: high-value short memories preferred over low-value long ones
   - Test: excludedReasons populated with budget reason
   - Test: tokenEstimate is roughly len/4
   - Test: without maxTokens → same behavior as v0.7 (no tokenEstimate field)
   - Test: estimateTokens('hello world') → 3

**Do NOT modify existing test files.**

---

### Prompt 6: consolidate() — VACUUM for Memory

**Context:** Prompts 1-5 applied. All trust, claim, supersession, re-ranking, and budget features are in place.

**Task:** Add `consolidate()` method — the full memory maintenance lifecycle.

**Requirements:**

1. **In `src/graph.mjs`, add `consolidate(opts)` method** (new section after COMPRESSION):

   ```
   // ══════════════════════════════════════════════════════════
   // CONSOLIDATION — Full memory maintenance lifecycle
   // ══════════════════════════════════════════════════════════
   ```

   **Implementation:**

   ```javascript
   async consolidate({
     dryRun = false,
     dedupThreshold = 0.95,
     compressAge = 30,
     pruneSuperseded = true,
     pruneAge = 90,
     method = 'extractive',
   } = {}) {
     await this.init();
     const start = Date.now();
     const report = {
       deduplicated: 0,
       contradictions: { resolved: 0, pending: 0 },
       corroborated: 0,
       compressed: { clusters: 0, sourceMemories: 0 },
       pruned: { superseded: 0, decayed: 0, disputed: 0 },
       before: { total: this.memories.length, active: this.memories.filter(m => m.status !== 'superseded').length },
       after: { total: 0, active: 0 },
       duration_ms: 0,
     };

     // Phase 1: Dedup — find near-identical active memories
     const deduped = new Set();
     for (let i = 0; i < this.memories.length; i++) {
       const a = this.memories[i];
       if (deduped.has(a.id) || a.status === 'superseded') continue;
       if (!a.embedding) continue;
       
       for (let j = i + 1; j < this.memories.length; j++) {
         const b = this.memories[j];
         if (deduped.has(b.id) || b.status === 'superseded') continue;
         if (!b.embedding) continue;
         
         const sim = cosineSimilarity(a.embedding, b.embedding);
         if (sim >= dedupThreshold) {
           // Keep the one with higher trust
           const aTrust = a.provenance?.trust ?? 0.5;
           const bTrust = b.provenance?.trust ?? 0.5;
           const [keep, remove] = aTrust >= bTrust ? [a, b] : [b, a];
           
           if (!dryRun) {
             // Merge tags from removed into kept
             const removeTags = remove.tags || [];
             for (const tag of removeTags) {
               if (!(keep.tags || []).includes(tag)) {
                 keep.tags = keep.tags || [];
                 keep.tags.push(tag);
               }
             }
             // Merge links
             for (const link of (remove.links || [])) {
               if (link.id !== keep.id && !(keep.links || []).find(l => l.id === link.id)) {
                 keep.links = keep.links || [];
                 keep.links.push(link);
               }
             }
             // Corroborate
             if (!keep.provenance) keep.provenance = { source: 'inference', corroboration: 1 };
             keep.provenance.corroboration = (keep.provenance.corroboration || 1) + 1;
             keep.updated_at = new Date().toISOString();
             
             // Remove duplicate
             remove.status = 'superseded';
             remove.superseded_by = keep.id;
             deduped.add(remove.id);
           }
           report.deduplicated++;
         }
       }
     }

     // Phase 2: Structural contradiction check
     if (!dryRun) {
       const claimMems = this.memories.filter(m => m.claim && m.status === 'active');
       const checked = new Set();
       for (const mem of claimMems) {
         const key = `${mem.claim.subject}::${mem.claim.predicate}`;
         if (checked.has(key)) continue;
         checked.add(key);
         
         const conflicts = this._structuralConflictCheck(mem.claim);
         // conflicts excludes mem itself (different value check)
         for (const existing of conflicts) {
           if (existing.id === mem.id) continue;
           const memTrust = mem.provenance?.trust ?? 0.5;
           const existingTrust = existing.provenance?.trust ?? 0.5;
           
           if (memTrust >= existingTrust) {
             existing.status = 'superseded';
             existing.superseded_by = mem.id;
             report.contradictions.resolved++;
           } else {
             report.contradictions.pending++;
           }
         }
       }
     }

     // Phase 3: Corroboration — boost confidence for memories confirmed by multiple sources
     if (!dryRun) {
       const active = this.memories.filter(m => m.status === 'active' && m.embedding);
       for (let i = 0; i < active.length; i++) {
         for (let j = i + 1; j < active.length; j++) {
           const sim = cosineSimilarity(active[i].embedding, active[j].embedding);
           if (sim > 0.9 && sim < dedupThreshold) {
             // Similar but not duplicate — different phrasing, same meaning
             const aSource = active[i].provenance?.source;
             const bSource = active[j].provenance?.source;
             if (aSource !== bSource) {
               // Different sources saying similar things — corroborate the higher-trust one
               const aTrust = active[i].provenance?.trust ?? 0.5;
               const bTrust = active[j].provenance?.trust ?? 0.5;
               const target = aTrust >= bTrust ? active[i] : active[j];
               if (!target.provenance) target.provenance = { source: 'inference', corroboration: 1 };
               target.provenance.corroboration = (target.provenance.corroboration || 1) + 1;
               report.corroborated++;
             }
           }
         }
       }
     }

     // Phase 4: Compress stale clusters
     if (!dryRun) {
       const cutoff = Date.now() - (compressAge * 24 * 60 * 60 * 1000);
       const allClusters = await this.clusters(3);
       const staleClusters = allClusters.filter(c => {
         return c.memories.every(m => {
           const mem = this._byId(m.id);
           return mem && new Date(mem.updated_at || mem.created_at).getTime() < cutoff;
         });
       }).filter(c => !c.memories.some(m => this._byId(m.id)?.category === 'digest'));
       
       for (const cluster of staleClusters.slice(0, 5)) {
         try {
           const ids = cluster.memories.map(m => m.id);
           await this.compress(ids, { method, archiveOriginals: false });
           report.compressed.clusters++;
           report.compressed.sourceMemories += ids.length;
         } catch { continue; }
       }
     }

     // Phase 5: Prune
     if (!dryRun) {
       const toPrune = [];
       const now = Date.now();
       
       for (const mem of this.memories) {
         // Prune old superseded memories
         if (pruneSuperseded && mem.status === 'superseded') {
           const age = (now - new Date(mem.updated_at || mem.created_at).getTime()) / (1000 * 60 * 60 * 24);
           if (age > pruneAge) {
             toPrune.push({ mem, reason: 'superseded' });
             continue;
           }
         }
         // Prune disputed memories with very low trust
         if (mem.status === 'disputed' && (mem.provenance?.trust ?? 0.5) < 0.2) {
           toPrune.push({ mem, reason: 'disputed' });
           continue;
         }
         // Prune decayed memories
         const { strength } = this.calcStrength(mem);
         if (strength < this.config.deleteThreshold && mem.status !== 'superseded') {
           toPrune.push({ mem, reason: 'decayed' });
         }
       }
       
       if (toPrune.length > 0) {
         const archive = await this.storage.loadArchive();
         for (const { mem, reason } of toPrune) {
           archive.push({ ...mem, embedding: undefined, archived_at: new Date().toISOString(), archived_reason: `consolidate: ${reason}` });
           this._deindexMemory(mem);
           if (this.storage.incremental) await this.storage.remove(mem.id);
           report.pruned[reason] = (report.pruned[reason] || 0) + 1;
         }
         const pruneIds = new Set(toPrune.map(p => p.mem.id));
         this.memories = this.memories.filter(m => !pruneIds.has(m.id));
         // Clean broken links
         for (const mem of this.memories) {
           mem.links = (mem.links || []).filter(l => !pruneIds.has(l.id));
         }
         await this.storage.saveArchive(archive);
         if (!this.storage.incremental) await this.save();
       }
     }

     // Persist remaining changes
     if (!dryRun) {
       if (this.storage.incremental) {
         for (const mem of this.memories) await this.storage.upsert(mem);
       } else {
         await this.save();
       }
     }

     report.after.total = this.memories.length;
     report.after.active = this.memories.filter(m => m.status !== 'superseded').length;
     report.duration_ms = Date.now() - start;
     
     this.emit('consolidate', report);
     return report;
   }
   ```

2. **Create `test/consolidation.test.mjs`:**
   - Test: consolidate() deduplicates near-identical memories
   - Test: consolidate() resolves claim contradictions
   - Test: consolidate() corroborates cross-source similar memories
   - Test: consolidate() prunes old superseded memories
   - Test: consolidate() prunes disputed low-trust memories
   - Test: consolidate() prunes decayed memories
   - Test: dryRun: true → report only, no mutations
   - Test: report counts are accurate (before/after totals)
   - Test: consolidate on empty graph → no errors
   - Test: consolidate with no issues → report shows zeros

**Do NOT modify existing test files.**

---

### Prompt 7: Storage Backend Updates + Supabase Migration

**Context:** Prompts 1-6 applied. All features work with JSON and in-memory storage. Supabase needs schema updates.

**Task:** Update storage backends for v0.8 fields and create migration SQL.

**Requirements:**

1. **In `src/storage.mjs` (jsonStorage):**
   - Add `loadPendingConflicts()` / `savePendingConflicts()` — file: `pending-conflicts.json`, same pattern as episodes
   - Atomic writes (tmp + rename) like other save methods

2. **In `src/storage.mjs` (memoryStorage):**
   - Add `loadPendingConflicts()` / `savePendingConflicts()` — in-memory array

3. **In `src/supabase-storage.mjs`:**
   - Update `upsert()` to include new fields: `claim`, `provenance`, `confidence`, `status`, `reinforcements`, `disputes`, `superseded_by`, `supersedes`
   - Update `search()` RPC calls to filter by `status = 'active'` by default
   - Add `loadPendingConflicts()` / `savePendingConflicts()` using the new `pending_conflicts` table

4. **Create `sql/migration-v0.8.sql`:**
   ```sql
   -- neolata-mem v0.8.0 migration: Trustworthy Memory
   -- Run this against your Supabase project to add v0.8 fields.
   
   -- New columns on memories table
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS claim jsonb;
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS provenance jsonb DEFAULT '{"source":"inference","corroboration":1,"trust":0.5}';
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence float DEFAULT 0.5;
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcements integer DEFAULT 0;
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS disputes integer DEFAULT 0;
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by text;
   ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes text[];
   
   -- Indexes
   CREATE INDEX IF NOT EXISTS idx_memories_claim_sp 
     ON memories ((claim->>'subject'), (claim->>'predicate')) 
     WHERE claim IS NOT NULL;
   CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
   CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories (confidence);
   
   -- Pending conflicts table
   CREATE TABLE IF NOT EXISTS pending_conflicts (
     id text PRIMARY KEY,
     new_id text NOT NULL,
     existing_id text NOT NULL,
     new_trust float NOT NULL,
     existing_trust float NOT NULL,
     new_claim jsonb,
     existing_claim jsonb,
     created_at timestamptz DEFAULT now(),
     resolved_at timestamptz,
     resolution text
   );
   
   -- Update search RPCs to filter by status
   CREATE OR REPLACE FUNCTION search_memories_semantic(
     query_embedding vector(1024),
     match_threshold float DEFAULT 0.5,
     match_count int DEFAULT 10,
     filter_agent text DEFAULT NULL,
     filter_status text DEFAULT 'active'
   )
   RETURNS TABLE (
     id text, agent text, memory text, category text,
     importance float, tags text[], created_at timestamptz,
     updated_at timestamptz, event_at timestamptz,
     claim jsonb, provenance jsonb, confidence float,
     status text, reinforcements int, disputes int,
     similarity float
   )
   LANGUAGE plpgsql AS $$
   BEGIN
     RETURN QUERY
     SELECT
       m.id, m.agent, m.memory, m.category,
       m.importance, m.tags, m.created_at,
       m.updated_at, m.event_at,
       m.claim, m.provenance, m.confidence,
       m.status, m.reinforcements, m.disputes,
       1 - (m.embedding <=> query_embedding) AS similarity
     FROM memories m
     WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
       AND (filter_agent IS NULL OR m.agent = filter_agent)
       AND (filter_status IS NULL OR m.status = filter_status)
     ORDER BY m.embedding <=> query_embedding
     LIMIT match_count;
   END;
   $$;
   ```

5. **Create `test/v080-migration.test.mjs`:**
   - Test: jsonStorage loads/saves pending conflicts
   - Test: memoryStorage loads/saves pending conflicts
   - Test: memories without v0.8 fields still load correctly (backward compat)
   - Test: store with provenance → persisted and reloaded correctly

**Do NOT modify existing test files.**

---

### Prompt 8: Integration Tests + Package Updates

**Context:** All prompts 1-7 applied. All features implemented and unit tested.

**Task:** Write integration tests that exercise the full v0.8 flow end-to-end, and update package metadata.

**Requirements:**

1. **Create `test/v080-integration.test.mjs`:**

   **Test suite: "v0.8 Trustworthy Memory — Integration"**

   - **"Full lifecycle: store → conflict → supersede → consolidate"**
     - Store memory A: "User budget is $500" with claim {subject:'user', predicate:'budget_is', value:'$500'}, provenance {source:'user_explicit'}
     - Store memory B: "User budget is $750" with same subject/predicate but value:'$750', provenance {source:'user_explicit'}
     - Assert: A is superseded, B is active
     - Assert: B.supersedes includes A.id
     - Search for "budget" → only returns B
     - Search with includeAll: true → returns both
     
   - **"Trust gating blocks low-trust override"**
     - Store "User is vegetarian" with provenance {source:'user_explicit'} (trust ~1.0)
     - Store "User eats meat" with provenance {source:'document'} (trust ~0.6) — same claim subject/predicate
     - Assert: original NOT superseded
     - Assert: pending conflict created
     - Resolve conflict with 'reject' → new memory archived
     - Search → only vegetarian result
   
   - **"Feedback loop: dispute + corroborate"**
     - Store a memory with provenance {source:'inference'} (trust ~0.5)
     - Dispute 3x → status becomes 'disputed', trust < 0.3
     - Store another memory, corroborate 5x → trust increases, confidence increases
   
   - **"Budget-aware context assembly"**
     - Store 20 memories of varying lengths
     - context() with maxTokens: 500 → fewer memories, tokenEstimate ≤ 500
     - context() without maxTokens → all 15 returned as before
   
   - **"consolidate() full cycle"**
     - Store 10 memories: 2 near-duplicates, 2 contradicting claims, 3 very old
     - Run consolidate()
     - Assert: duplicates merged, contradictions resolved, old memories compressed/pruned
     - Assert: report counts match expectations
   
   - **"Re-ranking changes result order"**
     - Store memory A: high similarity to query, low trust (inference)
     - Store memory B: medium similarity, high trust (user_explicit)
     - Search with rerank → B ranks above A
     - Search with rerank: false → A ranks above B

2. **Update `package.json`:**
   - Version: `"0.8.0"`
   - Add keywords: `"trust"`, `"provenance"`, `"contradiction-resolution"`, `"belief-update"`, `"poisoning-defense"`
   - Description: `"Trustworthy graph-native memory engine for AI agents — belief updates, provenance tracking, trust-gated supersession, and poisoning resistance"`

3. **Update exports in `src/index.mjs`:**
   - Ensure `computeTrust`, `computeConfidence`, `estimateTokens` are re-exported

**Do NOT modify existing test files.**

---

## Summary of Deliverables per Prompt

| Prompt | Feature | Files Changed | Files Created | Tests Added |
|--------|---------|--------------|--------------|-------------|
| 1 | Claim model + trust scoring + dedup | `graph.mjs`, `index.mjs` | `test/claims.test.mjs` | ~21 |
| 2 | Trust-gated supersession + quarantine + conflicts() | `graph.mjs`, `storage.mjs` | `test/trust-gating.test.mjs` | ~17 |
| 3 | dispute() + corroborate() | `graph.mjs` | `test/trust-feedback.test.mjs` | ~11 |
| 4 | Re-ranking (orthogonal signals) | `graph.mjs` | `test/reranking.test.mjs` | ~7 |
| 5 | Budget-aware context | `graph.mjs`, `index.mjs` | `test/budget-context.test.mjs` | ~6 |
| 6 | consolidate() | `graph.mjs` | `test/consolidation.test.mjs` | ~11 |
| 7 | Storage + migration | `storage.mjs`, `supabase-storage.mjs` | `sql/migration-v0.8.sql`, `test/v080-migration.test.mjs` | ~4 |
| 8 | Integration + package | `package.json`, `index.mjs` | `test/v080-integration.test.mjs` | ~6 |
| **Total** | | **~7 files** | **~9 files** | **~83 tests** |

---

## Execution Order

```
Prompt 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
   │         │         │       │       │       │       │       │
   ▼         ▼         ▼       ▼       ▼       ▼       ▼       ▼
 Claims   Trust-    Feedback  Rerank  Budget  VACUUM  Storage  Ship
 + Index  Gating    loops              context         + SQL    
```

Each prompt depends on the previous. Run tests after each prompt to ensure nothing breaks.
