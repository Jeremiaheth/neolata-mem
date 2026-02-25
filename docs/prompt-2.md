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
     // action === 'keep_both' â†’ no mutations, just resolve
     
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
   - Test: store conflicting claim with higher trust â†’ old memory superseded
   - Test: store conflicting claim with lower trust â†’ new memory quarantined + pending conflict created
   - Test: store conflicting claim with equal trust â†’ supersession (newer wins)
   - Test: search returns only active by default (excludes superseded, quarantined, disputed)
   - Test: search with includeAll: true â†’ includes all statuses
   - Test: search with statusFilter: ['active', 'disputed'] â†’ includes both
   - Test: search with sessionId overrides with matching session-scoped claims
   - Test: pendingConflicts() returns unresolved conflicts
   - Test: conflicts({ subject: 'user' }) filters by subject
   - Test: resolveConflict('supersede') â†’ quarantined memory activated, existing superseded
   - Test: resolveConflict('reject') â†’ quarantined memory archived
   - Test: resolveConflict('keep_both') â†’ both activated, conflict removed
   - Test: supersede event emitted
   - Test: conflict:pending event emitted
   - Test: existing evolve() still works (backward compat)
   - Test: store without claims â†’ no conflict checking (backward compat)
   - Test: exact-value duplicate â†’ corroborate, no new node

**Do NOT modify existing test files.**

