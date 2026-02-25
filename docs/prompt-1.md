### Prompt 1: Claim-Based Memory Model â€” Data Model + Index

**Context:** You are modifying `neolata-mem`, a graph-native memory engine for AI agents. The codebase is in `src/graph.mjs` (2037 lines, ES module). All tests are in `test/` using Vitest.

**Task:** Add claim-based memory support to the data model.

**Requirements:**

1. **In `src/graph.mjs`:**
   - Add a `_claimIndex: Map<string, Set<string>>` field in the constructor, alongside `_idIndex` and `_tokenIndex`
   - Key format: `${subject}::${predicate}` â†’ Set of memory IDs
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
   - In `store()`, **before creating a new memory**: if claim is provided, check for exact duplicate via `_findExactClaimDuplicate()`. If found, call `corroborate(existing.id)`, update `existing.updated_at`, and return existing memory with `{ deduplicated: true }` â€” do NOT create a new node.
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
   - Test: store with claim â†’ memory has claim field
   - Test: store with claim â†’ claim indexed in _claimIndex
   - Test: _structuralConflictCheck finds conflicting exclusive claims
   - Test: _structuralConflictCheck ignores same-value claims (not a conflict)
   - Test: _structuralConflictCheck ignores superseded/quarantined memories
   - Test: _structuralConflictCheck ignores non-exclusive predicates (exclusive: false)
   - Test: _structuralConflictCheck ignores non-overlapping validity windows
   - Test: _structuralConflictCheck detects overlapping validity windows
   - Test: _structuralConflictCheck: session-scoped claim does not conflict with global
   - Test: store same (subject, predicate, value) â†’ dedup (corroborate existing, no new node)
   - Test: store without claim â†’ backward compatible, no claim field
   - Test: claim validation (missing subject/predicate â†’ error)
   - Test: claim with scope='session' but no sessionId â†’ validation error
   - Test: provenance defaults applied when not specified
   - Test: computeTrust with user_explicit â†’ 1.0
   - Test: computeTrust with inference â†’ 0.5
   - Test: computeTrust with corroboration bonus
   - Test: computeTrust with disputes â†’ reduced trust
   - Test: computeConfidence equals trust score (no double-counting)
   - Test: deindex removes from _claimIndex
   - Test: rebuildIndexes rebuilds _claimIndex
   - Test: default exclusive: true when not specified
   - Use existing test helpers: `fakeEmbeddings`, `createTestGraph` pattern from `test/graph.test.mjs`

**Do NOT modify any existing test files. Do NOT change the behavior of any existing method when called without the new optional parameters.**

