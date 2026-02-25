IMPORTANT: Prompts 1-4 are already applied. All trust, claim, supersession, dispute(), corroborate(), reinforce(), and _rerank() features exist. Do NOT duplicate existing methods.

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
   - Test: context with maxTokens: 200 â†’ fewer memories than unlimited
   - Test: high-value short memories preferred over low-value long ones
   - Test: excludedReasons populated with budget reason
   - Test: tokenEstimate is roughly len/4
   - Test: without maxTokens â†’ same behavior as v0.7 (no tokenEstimate field)
   - Test: estimateTokens('hello world') â†’ 3

**Do NOT modify existing test files.**

---

### Prompt 6: consolidate() â€” VACUUM for Memory

**Context:** Prompts 1-5 applied. All trust, claim, supersession, re-ranking, and budget features are in place.

**Task:** Add `consolidate()` method â€” the full memory maintenance lifecycle.

**Requirements:**

1. **In `src/graph.mjs`, add `consolidate(opts)` method** (new section after COMPRESSION):

   ```
   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   // CONSOLIDATION â€” Full memory maintenance lifecycle
   // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
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

     // Phase 1: Dedup â€” find near-identical active memories
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

     // Phase 3: Corroboration â€” boost confidence for memories confirmed by multiple sources
     if (!dryRun) {
       const active = this.memories.filter(m => m.status === 'active' && m.embedding);
       for (let i = 0; i < active.length; i++) {
         for (let j = i + 1; j < active.length; j++) {
           const sim = cosineSimilarity(active[i].embedding, active[j].embedding);
           if (sim > 0.9 && sim < dedupThreshold) {
             // Similar but not duplicate â€” different phrasing, same meaning
             const aSource = active[i].provenance?.source;
             const bSource = active[j].provenance?.source;
             if (aSource !== bSource) {
               // Different sources saying similar things â€” corroborate the higher-trust one
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
   - Test: dryRun: true â†’ report only, no mutations
