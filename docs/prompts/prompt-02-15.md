You are implementing neolata-mem v0.6.0 features. Prompt 1 is already done (type: 'similar' on links in store/storeMany). Execute ALL of the following prompts IN ORDER. After each major change, run `npx vitest run` to verify all tests pass. If tests fail, fix the issue before continuing.

IMPORTANT: Tests use vitest. Run with `npx vitest run`. All 145 existing tests must continue to pass.

---

## Prompt 2: Read-Time Default for Old Links

In `src/graph.mjs`, the `links()` method maps over `mem.links` to create the return value. Add `type: link.type || 'similar'` to the returned objects.

Find in `links()`:
```js
return {
  id: link.id,
  similarity: link.similarity,
  memory: target?.memory || '(deleted)',
  agent: target?.agent || '?',
  category: target?.category || '?',
};
```

Change to:
```js
return {
  id: link.id,
  similarity: link.similarity,
  type: link.type || 'similar',
  memory: target?.memory || '(deleted)',
  agent: target?.agent || '?',
  category: target?.category || '?',
};
```

Add test in `test/graph.test.mjs` in the `links` describe block (or create one at the end before the closing of the main describe):

```js
it('should default link type to "similar" for old-format links', async () => {
  const graph = createTestGraph();
  graph.memories.push({
    id: 'mem_old-1', agent: 'a', memory: 'old memory', category: 'fact',
    importance: 0.7, tags: [], embedding: null,
    links: [{ id: 'mem_old-2', similarity: 0.8 }],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  graph.memories.push({
    id: 'mem_old-2', agent: 'a', memory: 'another old memory', category: 'fact',
    importance: 0.7, tags: [], embedding: null,
    links: [{ id: 'mem_old-1', similarity: 0.8 }],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  graph._rebuildIndexes();
  const result = await graph.links('mem_old-1');
  expect(result.links[0].type).toBe('similar');
});
```

Run tests after this change.

---

## Prompt 3: Supersedes Links in evolve()

In `src/graph.mjs`, in the `evolve()` method:

After the loop that archives conflicting memories, add:
```js
const archivedIds = actions.filter(a => a.type === 'archived').map(a => a.id);
```

After the novel store call (`const result = await this.store(agent, text, ...)`), add:
```js
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

Add a mockLLM helper at the top of test/graph.test.mjs (near fakeEmbeddings):
```js
function mockLLM(response) {
  return {
    name: 'mock-llm',
    async chat() { return JSON.stringify(response); },
  };
}
```

Add test:
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
    const original = await graph.store('agent-1', 'Server runs on port 3000');
    const result = await graph.evolve('agent-1', 'Server now runs on port 8080');
    expect(result.actions.some(a => a.type === 'archived')).toBe(true);
    expect(result.stored).toBe(true);
    if (result.id) {
      const newMem = graph.memories.find(m => m.id === result.id);
      if (newMem) {
        const supersedesLink = newMem.links.find(l => l.type === 'supersedes');
        expect(supersedesLink).toBeDefined();
        expect(supersedesLink.id).toBe(original.id);
      }
    }
  });
});
```

Run tests.

---

## Prompt 4: Type Filter for traverse() and path()

In `src/graph.mjs`:

Change `traverse()` signature from:
```js
async traverse(startId, maxHops = 2)
```
To:
```js
async traverse(startId, maxHops = 2, { types } = {})
```

In its inner loop, change:
```js
if (hop < maxHops) {
  for (const link of (mem.links || [])) {
    if (!visited.has(link.id)) {
      queue.push({ id: link.id, hop: hop + 1, similarity: link.similarity });
    }
  }
}
```
To:
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

Change `path()` signature from:
```js
async path(idA, idB)
```
To:
```js
async path(idA, idB, { types } = {})
```

In its inner loop, change:
```js
for (const link of (mem.links || [])) {
  if (!visited.has(link.id)) {
    visited.set(link.id, id);
    queue.push(link.id);
  }
}
```
To:
```js
for (const link of (mem.links || [])) {
  if (visited.has(link.id)) continue;
  const linkType = link.type || 'similar';
  if (types && !types.includes(linkType)) continue;
  visited.set(link.id, id);
  queue.push(link.id);
}
```

Add tests in `test/graph.test.mjs`:

```js
describe('traverse with type filter', () => {
  it('should only follow links of specified types', async () => {
    const graph = createTestGraph();
    const now = new Date().toISOString();
    graph.memories = [
      { id: 'mem_a', agent: 'a', memory: 'mem a', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_b', similarity: 0.9, type: 'similar' }, { id: 'mem_c', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
      { id: 'mem_b', agent: 'a', memory: 'mem b', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_a', similarity: 0.9, type: 'similar' }], created_at: now, updated_at: now },
      { id: 'mem_c', agent: 'a', memory: 'mem c', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_a', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
    ];
    graph.loaded = true;
    graph._rebuildIndexes();
    const result = await graph.traverse('mem_a', 2, { types: ['similar'] });
    const ids = result.nodes.map(n => n.id);
    expect(ids).toContain('mem_a');
    expect(ids).toContain('mem_b');
    expect(ids).not.toContain('mem_c');
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
    const noPath = await graph.path('mem_x', 'mem_z', { types: ['similar'] });
    expect(noPath.found).toBe(false);
    const found = await graph.path('mem_x', 'mem_z', { types: ['supersedes'] });
    expect(found.found).toBe(true);
    expect(found.hops).toBe(1);
  });
});
```

Run tests.

---

## Prompt 5: Manual link() and unlink() Methods

Add these two methods to MemoryGraph in `src/graph.mjs`, in the LINKS section (after `links()`, before `traverse()`):

```js
async link(sourceId, targetId, { type = 'related', similarity = null } = {}) {
  await this.init();
  if (sourceId === targetId) throw new Error('Cannot link a memory to itself');
  const source = this._byId(sourceId);
  const target = this._byId(targetId);
  if (!source) throw new Error(`Memory not found: ${sourceId}`);
  if (!target) throw new Error(`Memory not found: ${targetId}`);
  if (typeof type !== 'string' || type.length === 0 || type.length > 50) {
    throw new Error('Link type must be a non-empty string (max 50 chars)');
  }
  const now = new Date().toISOString();
  const existingForward = source.links.findIndex(l => l.id === targetId);
  if (existingForward >= 0) {
    source.links[existingForward] = { id: targetId, similarity, type };
  } else {
    source.links.push({ id: targetId, similarity, type });
  }
  source.updated_at = now;
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

Add tests in `test/graph.test.mjs`:

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

Run tests.

---

## Prompt 6: Supabase Typed Links

In `src/supabase-storage.mjs`:

1. In `loadLinks()`, change the SELECT query:
   From: `select=source_id,target_id,strength`
   To: `select=source_id,target_id,strength,link_type`

2. In `loadLinks()`, change the link push lines:
   From: `{ id: l.target_id, similarity: l.strength }`
   To: `{ id: l.target_id, similarity: l.strength, type: l.link_type || 'similar' }`
   (same for the reverse direction)

3. In `save()`, where linkRows are built, add `link_type: link.type || 'similar'` to each row.

4. In `upsertLinks()`, add `link_type: l.type || 'similar'` to each row.

Run tests.

---

## Prompt 7: Link Events Include Type

In `src/graph.mjs`, in `store()`, find:
```js
this.emit('link', { sourceId: id, targetId: link.id, similarity: link.similarity });
```
Change to:
```js
this.emit('link', { sourceId: id, targetId: link.id, similarity: link.similarity, type: 'similar' });
```

Add test in `test/events.test.mjs`:

```js
it('should emit link events with type field', async () => {
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

Run tests.

---

## Prompt 8: SM-2 New Fields in reinforce()

In `src/graph.mjs`:

1. In the constructor config block, add:
```js
initialStability: config.initialStability ?? 1.0,
stabilityGrowth: config.stabilityGrowth ?? 2.0,
```

2. Replace the body of `reinforce()` (keeping signature and the init/lookup):

```js
async reinforce(memoryId, boost = 0.1) {
  await this.init();
  const mem = this._byId(memoryId);
  if (!mem) return null;

  const oldImportance = mem.importance;
  const now = new Date();
  const lastTouch = new Date(mem.updated_at || mem.created_at);
  const daysSinceTouch = (now.getTime() - lastTouch.getTime()) / (1000 * 60 * 60 * 24);

  mem.importance = Math.min(1.0, (mem.importance || 0.5) + boost);
  mem.accessCount = (mem.accessCount || 0) + 1;

  // SM-2 stability: grows more with spaced reviews
  const previousInterval = mem.lastReviewInterval || 1;
  const currentInterval = Math.max(0.01, daysSinceTouch);
  const spacingFactor = Math.min(3.0, currentInterval / Math.max(1, previousInterval));
  const growthRate = this.config.stabilityGrowth;
  mem.stability = (mem.stability ?? this.config.initialStability) * (1.0 + (growthRate - 1.0) * spacingFactor / 3.0);
  mem.lastReviewInterval = currentInterval;

  mem.updated_at = now.toISOString();

  if (this.storage.incremental) {
    await this.storage.upsert(mem);
  } else {
    await this.save();
  }

  const { strength } = this.calcStrength(mem);
  return { id: mem.id, memory: mem.memory, oldImportance, newImportance: mem.importance, accessCount: mem.accessCount, strength: +strength.toFixed(3) };
}
```

Add test in `test/graph.test.mjs`:

```js
describe('reinforce with stability', () => {
  it('should set stability and lastReviewInterval on reinforce', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Important fact');
    await graph.reinforce(r.id);
    const mem = graph.memories.find(m => m.id === r.id);
    expect(typeof mem.stability).toBe('number');
    expect(mem.stability).toBeGreaterThan(0);
    expect(typeof mem.lastReviewInterval).toBe('number');
  });
  it('should increase stability more with spaced reinforcement', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Rapid reinforced');
    await graph.reinforce(r1.id);
    await graph.reinforce(r1.id);
    await graph.reinforce(r1.id);
    const rapid = graph.memories.find(m => m.id === r1.id);
    const r2 = await graph.store('a', 'Spaced reinforced');
    const mem2 = graph.memories.find(m => m.id === r2.id);
    mem2.updated_at = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await graph.reinforce(r2.id);
    mem2.updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await graph.reinforce(r2.id);
    mem2.updated_at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await graph.reinforce(r2.id);
    const spaced = graph.memories.find(m => m.id === r2.id);
    expect(spaced.stability).toBeGreaterThan(rapid.stability);
  });
});
```

Run tests.

---

## Prompt 9: SM-2 calcStrength() Formula

Replace `calcStrength()` in `src/graph.mjs` with:

```js
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
    const stability = Math.max(0.1, mem.stability);
    const retrievability = Math.exp(-0.5 * lastTouchDays / stability);
    const strength = Math.min(1.0, (base * retrievability * categoryWeight) + linkBonus);
    return { strength, ageDays, lastTouchDays, linkCount, base, retrievability, categoryWeight, stability, mode: 'sm2' };
  }

  const HALF_LIFE = this.config.decayHalfLifeDays;
  const ageFactor = Math.max(0.1, Math.pow(0.5, ageDays / HALF_LIFE));
  const touchFactor = Math.max(0.1, Math.pow(0.5, lastTouchDays / (HALF_LIFE * 2)));
  const accessBonus = Math.min(0.2, (mem.accessCount || 0) * 0.02);
  const strength = Math.min(1.0, (base * ageFactor * touchFactor * categoryWeight) + linkBonus + accessBonus);
  return { strength, ageDays, lastTouchDays, linkCount, base, ageFactor, touchFactor, categoryWeight, mode: 'legacy' };
}
```

Add tests:

```js
describe('calcStrength modes', () => {
  it('should use legacy mode for memories without stability', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Test memory');
    const mem = graph.memories.find(m => m.id === r.id);
    const result = graph.calcStrength(mem);
    expect(result.mode).toBe('legacy');
    expect(result.strength).toBeGreaterThan(0);
  });
  it('should use SM-2 mode for memories with stability', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Test memory');
    const mem = graph.memories.find(m => m.id === r.id);
    mem.stability = 5.0;
    const result = graph.calcStrength(mem);
    expect(result.mode).toBe('sm2');
  });
  it('should give higher strength to memories with higher stability', async () => {
    const graph = createTestGraph();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const lowStab = { importance: 0.7, stability: 1.0, links: [], category: 'fact', created_at: tenDaysAgo, updated_at: tenDaysAgo };
    const highStab = { importance: 0.7, stability: 20.0, links: [], category: 'fact', created_at: tenDaysAgo, updated_at: tenDaysAgo };
    const lowResult = graph.calcStrength(lowStab);
    const highResult = graph.calcStrength(highStab);
    expect(highResult.strength).toBeGreaterThan(lowResult.strength);
  });
});
```

Run tests.

---

## Prompt 10: Supabase SM-2 Fields + Health Report

In `src/supabase-storage.mjs`:

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

3. In `load()` SELECT query, add `stability,last_review_interval` to the columns.

In `src/graph.mjs`, in `health()`:

After the strength distribution loop, add:
```js
const stabilityValues = this.memories.filter(m => m.stability != null).map(m => m.stability);
const avgStability = stabilityValues.length ? +(stabilityValues.reduce((a, b) => a + b, 0) / stabilityValues.length).toFixed(2) : null;
const memoriesWithSM2 = stabilityValues.length;
```

Add `avgStability` and `memoriesWithSM2` to the return object.

Add test:
```js
it('should include stability stats in health report', async () => {
  const graph = createTestGraph();
  await graph.store('a', 'Memory one');
  await graph.store('a', 'Memory two');
  const id = graph.memories[0].id;
  await graph.reinforce(id);
  const report = await graph.health();
  expect(report.memoriesWithSM2).toBe(1);
  expect(typeof report.avgStability).toBe('number');
});
```

Run tests.

---

## Prompt 11: Bi-Temporal eventTime in store() and storeMany()

In `src/graph.mjs`:

1. Change `store()` options from:
```js
async store(agent, text, { category = 'fact', importance = 0.7, tags = [] } = {})
```
To:
```js
async store(agent, text, { category = 'fact', importance = 0.7, tags = [], eventTime } = {})
```

After input validation, add:
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

In the `newMem` object, add: `...(eventAt !== undefined && { event_at: eventAt }),`

2. In `storeMany()`, for each item, add similar eventTime handling:
```js
let eventAt = undefined;
if (item.eventTime !== undefined) {
  const parsed = new Date(item.eventTime);
  if (isNaN(parsed.getTime())) throw new Error(`items[${i}].eventTime is not a valid date`);
  eventAt = parsed.toISOString();
}
```
And in the newMem: `...(eventAt !== undefined && { event_at: eventAt }),`

Add tests:
```js
describe('bi-temporal', () => {
  it('should store event_at when eventTime is provided', async () => {
    const graph = createTestGraph();
    const r = await graph.store('a', 'Server migrated to AWS', { eventTime: '2026-01-15T00:00:00Z' });
    const mem = graph.memories.find(m => m.id === r.id);
    expect(mem.event_at).toBe('2026-01-15T00:00:00.000Z');
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
    await expect(graph.store('a', 'test', { eventTime: 'not-a-date' })).rejects.toThrow('eventTime must be a valid ISO 8601 date string');
  });
  it('should support eventTime in storeMany', async () => {
    const graph = createTestGraph();
    const result = await graph.storeMany('a', [{ text: 'Event A', eventTime: '2026-01-10' }, { text: 'Event B' }]);
    expect(result.stored).toBe(2);
    const memA = graph.memories.find(m => m.memory === 'Event A');
    const memB = graph.memories.find(m => m.memory === 'Event B');
    expect(memA.event_at).toBeDefined();
    expect(memB.event_at).toBeUndefined();
  });
});
```

Run tests.

---

## Prompt 12: Timeline and Search Temporal Filters

In `src/graph.mjs`:

1. Change `timeline()` from:
```js
async timeline(agent = null, days = 7)
```
To:
```js
async timeline(agent = null, days = 7, { timeField = 'auto' } = {})
```

Replace the date logic in timeline with:
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

2. Change `search()` options from:
```js
async search(agent, query, { limit = 10, minSimilarity = 0 } = {})
```
To:
```js
async search(agent, query, { limit = 10, minSimilarity = 0, before, after } = {})
```

After the agent filter line (`if (agent) candidates = candidates.filter(...)`), add:
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

3. Change `context()` from:
```js
async context(agent, query, { maxMemories = 15 } = {})
```
To:
```js
async context(agent, query, { maxMemories = 15, before, after } = {})
```

Change search call inside:
```js
const results = await this.search(null, query, { limit: 8, before, after });
```

Add tests:
```js
describe('bi-temporal timeline', () => {
  it('should group by event_at when available', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Server migrated', { eventTime: '2026-01-15T12:00:00Z' });
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
    expect(tl.total).toBe(1);
  });
});

describe('search with temporal filters', () => {
  it('should filter by before/after', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'January event', { eventTime: '2026-01-15T00:00:00Z' });
    await graph.store('a', 'February event', { eventTime: '2026-02-15T00:00:00Z' });
    await graph.store('a', 'March event', { eventTime: '2026-03-15T00:00:00Z' });
    const results = await graph.search('a', 'event', { after: '2026-02-01', before: '2026-02-28' });
    expect(results.length).toBe(1);
    expect(results[0].memory).toBe('February event');
  });
  it('should use event_at for temporal filtering', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Past event', { eventTime: '2026-01-10T00:00:00Z' });
    const results = await graph.search('a', 'event', { before: '2026-01-31' });
    expect(results.length).toBe(1);
    const noResults = await graph.search('a', 'event', { after: '2026-03-01' });
    expect(noResults.length).toBe(0);
  });
});
```

Run tests.

---

## Prompt 13: Supabase event_at Field

In `src/supabase-storage.mjs`:

1. In `toRow()`, add: `event_at: mem.event_at || null,`
2. In `fromRow()`, add: `event_at: row.event_at || undefined,`
3. In `load()` SELECT, add `event_at` to the column list.
4. In `toArchiveRow()`, add: `event_at: mem.event_at || null,`
5. In `fromArchiveRow()`, add: `event_at: row.event_at || undefined,`

Run tests.

---

## Prompt 14: Integration Test

Create a new file `test/v060-integration.test.mjs`:

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
  return { name: 'mock-llm', async chat() { return JSON.stringify(response); } };
}

describe('v0.6.0 Integration', () => {
  it('full lifecycle: store → typed links → evolve → supersedes → search temporal → reinforce → SM-2 decay', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      llm: mockLLM({ conflicts: [{ index: 0, reason: 'version updated' }], updates: [], novel: true }),
      config: { linkThreshold: 0.1, initialStability: 1.0, stabilityGrowth: 2.0 },
    });
    const r1 = await graph.store('agent-1', 'Server runs on port 3000', { eventTime: '2026-01-15T00:00:00Z', category: 'fact' });
    expect(r1.id).toBeTruthy();
    const mem1 = graph.memories.find(m => m.id === r1.id);
    expect(mem1.event_at).toBe('2026-01-15T00:00:00.000Z');
    const r2 = await graph.store('agent-1', 'Server uses port 3000 for the API', { eventTime: '2026-01-16T00:00:00Z' });
    const mem2 = graph.memories.find(m => m.id === r2.id);
    if (mem2.links.length > 0) expect(mem2.links[0].type).toBe('similar');
    const janResults = await graph.search('agent-1', 'server port', { after: '2026-01-01', before: '2026-01-31' });
    expect(janResults.length).toBe(2);
    const evolved = await graph.evolve('agent-1', 'Server now runs on port 8080', { category: 'fact' });
    expect(evolved.actions.some(a => a.type === 'archived')).toBe(true);
    if (evolved.id) {
      const newMem = graph.memories.find(m => m.id === evolved.id);
      if (newMem) {
        const supersedesLinks = newMem.links.filter(l => l.type === 'supersedes');
        expect(supersedesLinks.length).toBeGreaterThan(0);
      }
      await graph.reinforce(evolved.id);
      const reinforced = graph.memories.find(m => m.id === evolved.id);
      expect(reinforced.stability).toBeDefined();
      const strength = graph.calcStrength(reinforced);
      expect(strength.mode).toBe('sm2');
    }
    const health = await graph.health();
    expect(health.total).toBeGreaterThan(0);
    expect('memoriesWithSM2' in health).toBe(true);
  });

  it('backward compatibility: old-format memories work correctly', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      config: { linkThreshold: 0.1 },
    });
    const now = new Date().toISOString();
    graph.memories = [
      { id: 'mem_legacy-1', agent: 'a', memory: 'old memory one', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_legacy-2', similarity: 0.8 }], created_at: now, updated_at: now },
      { id: 'mem_legacy-2', agent: 'a', memory: 'old memory two', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_legacy-1', similarity: 0.8 }], created_at: now, updated_at: now },
    ];
    graph.loaded = true;
    graph._rebuildIndexes();
    const links = await graph.links('mem_legacy-1');
    expect(links.links[0].type).toBe('similar');
    const strength = graph.calcStrength(graph.memories[0]);
    expect(strength.mode).toBe('legacy');
    const tl = await graph.timeline('a', 1);
    expect(tl.total).toBe(2);
    const results = await graph.search('a', 'old memory');
    expect(results.length).toBe(2);
    await graph.reinforce('mem_legacy-1');
    const mem = graph.memories.find(m => m.id === 'mem_legacy-1');
    expect(mem.stability).toBeDefined();
    expect(graph.calcStrength(mem).mode).toBe('sm2');
  });
});
```

Run `npx vitest run` and confirm ALL tests pass.

---

## Prompt 15: Version Bump

In `package.json`, change `"version": "0.5.3"` to `"version": "0.6.0"`.

Run `npx vitest run` one final time to confirm everything passes.

When completely finished with ALL prompts, run:
openclaw system event --text "Done: All 15 prompts complete - neolata-mem v0.6.0 implemented with typed edges, SM-2 decay, and bi-temporal tracking" --mode now
