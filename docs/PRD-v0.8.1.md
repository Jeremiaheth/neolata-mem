# PRD v0.8.1 — Self-healing, Trustworthy Memory

Extends v0.8 with three high-leverage features: Predicate Schema Registry, Explainability API, Quarantine Lane.

## Feature 7: Predicate Schema Registry

### Data Model
```js
PredicateSchema = {
  predicate: string,
  cardinality: 'single' | 'multi',
  conflictPolicy: 'supersede' | 'require_review' | 'keep_both',
  normalize?: 'none' | 'trim' | 'lowercase' | 'lowercase_trim' | 'currency',
  dedupPolicy?: 'corroborate' | 'store',
}
```

### Config
```js
new MemoryGraph({
  predicateSchemas: {
    budget_is: { cardinality: 'single', conflictPolicy: 'supersede', normalize: 'currency' },
    likes: { cardinality: 'multi', conflictPolicy: 'keep_both', normalize: 'lowercase_trim', dedupPolicy: 'corroborate' },
  }
})
```

Defaults (no schema): cardinality='single', conflictPolicy='supersede', normalize='none', dedupPolicy='corroborate'

### Normalizers (pure, deterministic)
- `none` → identity
- `trim` → `value.trim()`
- `lowercase` → `value.toLowerCase()`
- `lowercase_trim` → `value.trim().toLowerCase()`
- `currency` → best-effort normalize ("$750", "750 USD" → "USD 750")

Store normalized output on claim as `claim.normalizedValue`.
Conflict checks use `normalizedValue` when present, else `value`.

### API
```js
mem.registerPredicate('likes', { cardinality: 'multi', conflictPolicy: 'keep_both' });
mem.registerPredicates({ budget_is: {...}, likes: {...} });
const schema = mem.getPredicateSchema('budget_is');
const all = mem.listPredicateSchemas();
```

### Store() Changes (when claim present)
1. Get schema for claim.predicate
2. Normalize value → claim.normalizedValue
3. Detect collisions by (subject,predicate) among active memories with overlapping validity
4. Apply semantics:
   - **multi cardinality**: different values NOT contradictions. Same normalizedValue → corroborate existing (unless dedupPolicy='store')
   - **single cardinality**: different values are contradictions if validity overlaps. Apply conflictPolicy:
     - `supersede`: trust-gated supersession (v0.8 behavior)
     - `require_review`: quarantine new memory + pending conflict
     - `keep_both`: both active, mark conflict resolved as keep_both

### _findExactClaimDuplicate Changes
Must use normalizedValue for comparison when available.

### _structuralConflictCheck Changes
- Skip conflict check entirely for multi-cardinality predicates
- Use normalizedValue for value comparison
- Apply conflictPolicy from schema

## Feature 8: Explainability API

### search() with explain:true
Returns array with `.meta` property:
```js
results.meta = {
  query, agent, options: { /* sanitized */ },
  counts: { candidates, afterAgentFilter, afterStatusFilter, afterSimilarity, returned },
  excluded: { superseded, disputed, quarantined, archived, belowMinSimilarity, scopeMismatch, validityMismatch },
};
```

Each item gets `explain`:
```js
{
  explain: {
    retrieved: { vectorSimilarity, keywordScore, keywordHits },
    rerank: { weights, signals, compositeScore },
    status: { status, superseded_by, quarantine },
  }
}
```

### context() with explain:true
```js
ctx.explain = {
  searchMeta: results.meta,
  packing: { maxTokens, tokenEstimate, includedIds, excluded: [{ id, reason, value }] },
};
```

### Helper methods
```js
mem.explainMemory(memoryId)      // status/trust/confidence + provenance + claim
mem.explainSupersession(memoryId) // if superseded: which memory, trust comparison
```

Only compute explain data when explain:true. No breaking changes to default output.

## Feature 9: Quarantine Lane

### Status enum
`'active' | 'superseded' | 'disputed' | 'quarantined' | 'archived'`

### Quarantine metadata (optional field on memory)
```js
quarantine?: {
  reason: 'trust_insufficient' | 'predicate_requires_review' | 'suspicious_input' | 'manual',
  details?: string,
  created_at: string,
  resolved_at?: string,
  resolution?: 'activated' | 'rejected' | 'kept_quarantined',
}
```

### store() changes
When conflict blocked OR schema requires review:
- status='quarantined'
- Write pending conflict
- Return { pendingConflictId, quarantined: true }

Optional: `onConflict: 'quarantine' | 'keep_active'` (default: 'quarantine')

### Retrieval defaults
Default: status === 'active' only.
Options: includeSuperseded, includeDisputed, includeQuarantined (all boolean, default false)

### Review APIs
```js
await mem.listQuarantined({ agent, limit: 50 });
await mem.reviewQuarantine(memoryId, { action: 'activate' | 'reject', reason? });
await mem.quarantine(memoryId, { reason: 'manual', details: 'flagged by operator' });
```

### Integration with resolveConflict()
- activate: status→active, optionally re-run conflict resolution
- reject: archive/remove
- Mark quarantine resolved accordingly

### Consolidation
- `pruneQuarantined: true` (default false)
- `quarantineMaxAgeDays: 30` (default 30)
- Only prune quarantined with accessCount === 0

### Supabase migration
```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS quarantine jsonb;
CREATE INDEX IF NOT EXISTS idx_memories_quarantined ON memories (status) WHERE status = 'quarantined';
```
