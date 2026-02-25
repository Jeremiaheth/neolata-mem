IMPORTANT: Prompts 1-2 are already applied. corroborate() already exists from Prompt 1 — update it to also set mem.confidence and emit 'corroborate' event per the spec below. Do NOT create duplicate methods.

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
   - Test: dispute() below threshold â†’ status becomes 'disputed'
   - Test: dispute() on non-existent memory â†’ returns null
   - Test: corroborate() increments corroboration count
   - Test: corroborate() recomputes trust (higher)
   - Test: corroborate() on non-existent memory â†’ returns null
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
   - Ensure `confidence` is included in result objects (it's the trust score â€” orthogonal to importance and recency in the reranker)

   **Modify `searchMany()`:**
   - Add `rerank`, `includeAll`, and `statusFilter` options
   - Apply same status filtering + re-ranking per query

2. **Create `test/reranking.test.mjs`:**
   - Use `createTestGraph` pattern from existing tests
   - Store 5 memories with different provenance sources (different trust levels), different ages, and different importance
   - Test: default re-ranking reorders results (high-confidence memory ranks above higher-similarity but low-confidence)
   - Test: compositeScore and rankingSignals present on results
   - Test: rerank: false â†’ results sorted by raw similarity
   - Test: custom weights shift ranking (e.g., all weight on recency)
   - Test: superseded memories filtered by default
   - Test: includeAll: true includes all statuses
   - Test: searchMany with rerank works per-query

**Do NOT modify existing test files.**

---

