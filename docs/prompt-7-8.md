IMPORTANT: Prompts 1-6 are already applied. All trust, claim, supersession, dispute(), corroborate(), _rerank(), estimateTokens(), budget-aware context(), and consolidate() exist. Do NOT duplicate existing methods.

   - Test: report counts are accurate (before/after totals)
   - Test: consolidate on empty graph â†’ no errors
   - Test: consolidate with no issues â†’ report shows zeros

**Do NOT modify existing test files.**

---

### Prompt 7: Storage Backend Updates + Supabase Migration

**Context:** Prompts 1-6 applied. All features work with JSON and in-memory storage. Supabase needs schema updates.

**Task:** Update storage backends for v0.8 fields and create migration SQL.

**Requirements:**

1. **In `src/storage.mjs` (jsonStorage):**
   - Add `loadPendingConflicts()` / `savePendingConflicts()` â€” file: `pending-conflicts.json`, same pattern as episodes
   - Atomic writes (tmp + rename) like other save methods

2. **In `src/storage.mjs` (memoryStorage):**
   - Add `loadPendingConflicts()` / `savePendingConflicts()` â€” in-memory array

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
   - Test: store with provenance â†’ persisted and reloaded correctly

**Do NOT modify existing test files.**

---

### Prompt 8: Integration Tests + Package Updates

**Context:** All prompts 1-7 applied. All features implemented and unit tested.

**Task:** Write integration tests that exercise the full v0.8 flow end-to-end, and update package metadata.

**Requirements:**

1. **Create `test/v080-integration.test.mjs`:**

   **Test suite: "v0.8 Trustworthy Memory â€” Integration"**

   - **"Full lifecycle: store â†’ conflict â†’ supersede â†’ consolidate"**
     - Store memory A: "User budget is $500" with claim {subject:'user', predicate:'budget_is', value:'$500'}, provenance {source:'user_explicit'}
     - Store memory B: "User budget is $750" with same subject/predicate but value:'$750', provenance {source:'user_explicit'}
     - Assert: A is superseded, B is active
     - Assert: B.supersedes includes A.id
     - Search for "budget" â†’ only returns B
     - Search with includeAll: true â†’ returns both
     
   - **"Trust gating blocks low-trust override"**
     - Store "User is vegetarian" with provenance {source:'user_explicit'} (trust ~1.0)
     - Store "User eats meat" with provenance {source:'document'} (trust ~0.6) â€” same claim subject/predicate
     - Assert: original NOT superseded
     - Assert: pending conflict created
     - Resolve conflict with 'reject' â†’ new memory archived
     - Search â†’ only vegetarian result
   
   - **"Feedback loop: dispute + corroborate"**
     - Store a memory with provenance {source:'inference'} (trust ~0.5)

     - Dispute 3x â†’ status becomes 'disputed', trust < 0.3
     - Store another memory, corroborate 5x â†’ trust increases, confidence increases
   
   - **"Budget-aware context assembly"**
     - Store 20 memories of varying lengths
     - context() with maxTokens: 500 â†’ fewer memories, tokenEstimate â‰¤ 500
     - context() without maxTokens â†’ all 15 returned as before
   
   - **"consolidate() full cycle"**
     - Store 10 memories: 2 near-duplicates, 2 contradicting claims, 3 very old
     - Run consolidate()
     - Assert: duplicates merged, contradictions resolved, old memories compressed/pruned
     - Assert: report counts match expectations
   
   - **"Re-ranking changes result order"**
     - Store memory A: high similarity to query, low trust (inference)
     - Store memory B: medium similarity, high trust (user_explicit)
     - Search with rerank â†’ B ranks above A
     - Search with rerank: false â†’ A ranks above B

2. **Update `package.json`:**
   - Version: `"0.8.0"`
   - Add keywords: `"trust"`, `"provenance"`, `"contradiction-resolution"`, `"belief-update"`, `"poisoning-defense"`
   - Description: `"Trustworthy graph-native memory engine for AI agents â€” belief updates, provenance tracking, trust-gated supersession, and poisoning resistance"`

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
Prompt 1 â†’ 2 â†’ 3 â†’ 4 â†’ 5 â†’ 6 â†’ 7 â†’ 8
   â”‚         â”‚         â”‚       â”‚       â”‚       â”‚       â”‚       â”‚
   â–¼         â–¼         â–¼       â–¼       â–¼       â–¼       â–¼       â–¼
 Claims   Trust-    Feedback  Rerank  Budget  VACUUM  Storage  Ship
 + Index  Gating    loops              context         + SQL    
```

Each prompt depends on the previous. Run tests after each prompt to ensure nothing breaks.

