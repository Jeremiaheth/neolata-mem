import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createTestGraph() {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config: { linkThreshold: 0.1 },
  });
}

describe('Trust-gated supersession', () => {
  it('store conflicting claim with higher trust supersedes old memory', async () => {
    const graph = createTestGraph();
    const old = await graph.store('a', 'Theme is blue', {
      claim: { subject: 'user', predicate: 'theme', value: 'blue', scope: 'global' },
      provenance: { source: 'inference' },
    });

    const newer = await graph.store('a', 'Theme is green', {
      claim: { subject: 'user', predicate: 'theme', value: 'green', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const oldMem = graph._byId(old.id);
    const newMem = graph._byId(newer.id);
    expect(oldMem.status).toBe('superseded');
    expect(oldMem.superseded_by).toBe(newer.id);
    expect(newMem.supersedes).toContain(old.id);
    expect(newMem.links.some(l => l.id === old.id && l.type === 'supersedes')).toBe(true);
  });

  it('store conflicting claim with lower trust quarantines new memory and creates pending conflict', async () => {
    const graph = createTestGraph();
    const old = await graph.store('a', 'Timezone is UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const newer = await graph.store('a', 'Timezone is PST', {
      claim: { subject: 'user', predicate: 'timezone', value: 'PST', scope: 'global' },
      provenance: { source: 'inference' },
    });

    const newMem = graph._byId(newer.id);
    expect(newMem.status).toBe('quarantined');
    const pending = await graph.pendingConflicts();
    expect(pending.length).toBe(1);
    expect(pending[0].newId).toBe(newer.id);
    expect(pending[0].existingId).toBe(old.id);
  });

  it('store conflicting claim with equal trust supersedes older memory', async () => {
    const graph = createTestGraph();
    const old = await graph.store('a', 'Language is English', {
      claim: { subject: 'user', predicate: 'language', value: 'en', scope: 'global' },
    });

    const newer = await graph.store('a', 'Language is Spanish', {
      claim: { subject: 'user', predicate: 'language', value: 'es', scope: 'global' },
    });

    expect(graph._byId(old.id).status).toBe('superseded');
    expect(graph._byId(old.id).superseded_by).toBe(newer.id);
  });

  it('search returns only active by default', async () => {
    const graph = createTestGraph();
    const active = await graph.store('a', 'status probe active');
    const superseded = await graph.store('a', 'status probe superseded');
    const quarantined = await graph.store('a', 'status probe quarantined');
    const disputed = await graph.store('a', 'status probe disputed');

    graph._byId(superseded.id).status = 'superseded';
    graph._byId(quarantined.id).status = 'quarantined';
    graph._byId(disputed.id).status = 'disputed';

    const results = await graph.search('a', 'status probe', { includeAll: false });
    const ids = new Set(results.map(r => r.id));
    expect(ids.has(active.id)).toBe(true);
    expect(ids.has(superseded.id)).toBe(false);
    expect(ids.has(quarantined.id)).toBe(false);
    expect(ids.has(disputed.id)).toBe(false);
  });

  it('search with includeAll=true includes all statuses', async () => {
    const graph = createTestGraph();
    const active = await graph.store('a', 'status all active');
    const superseded = await graph.store('a', 'status all superseded');
    const quarantined = await graph.store('a', 'status all quarantined');
    graph._byId(superseded.id).status = 'superseded';
    graph._byId(quarantined.id).status = 'quarantined';

    const results = await graph.search('a', 'status all', { includeAll: true });
    const ids = new Set(results.map(r => r.id));
    expect(ids.has(active.id)).toBe(true);
    expect(ids.has(superseded.id)).toBe(true);
    expect(ids.has(quarantined.id)).toBe(true);
  });

  it('search with statusFilter includes specified statuses', async () => {
    const graph = createTestGraph();
    const active = await graph.store('a', 'status custom active');
    const disputed = await graph.store('a', 'status custom disputed');
    const superseded = await graph.store('a', 'status custom superseded');

    graph._byId(disputed.id).status = 'disputed';
    graph._byId(superseded.id).status = 'superseded';

    const results = await graph.search('a', 'status custom', { statusFilter: ['active', 'disputed'] });
    const ids = new Set(results.map(r => r.id));
    expect(ids.has(active.id)).toBe(true);
    expect(ids.has(disputed.id)).toBe(true);
    expect(ids.has(superseded.id)).toBe(false);
  });

  it('search with sessionId overrides with matching session-scoped claims', async () => {
    const graph = createTestGraph();
    const global = await graph.store('a', 'Timezone is UTC globally', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const session = await graph.store('a', 'Timezone is PST for this session', {
      claim: { subject: 'user', predicate: 'timezone', value: 'PST', scope: 'session', sessionId: 's1' },
      provenance: { source: 'user_explicit' },
    });

    const results = await graph.search('a', 'timezone', { sessionId: 's1', includeAll: true });
    const ids = new Set(results.map(r => r.id));
    expect(ids.has(session.id)).toBe(true);
    expect(ids.has(global.id)).toBe(false);
  });

  it('pendingConflicts returns unresolved conflicts', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Currency is USD', {
      claim: { subject: 'user', predicate: 'currency', value: 'USD', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    await graph.store('a', 'Currency is EUR', {
      claim: { subject: 'user', predicate: 'currency', value: 'EUR', scope: 'global' },
      provenance: { source: 'inference' },
    });

    const pending = await graph.pendingConflicts();
    expect(pending.length).toBe(1);
    expect(pending[0].resolved_at).toBeUndefined();
  });

  it('conflicts({ subject }) filters by subject', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'User city is Berlin', {
      claim: { subject: 'user', predicate: 'city', value: 'Berlin', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    await graph.store('a', 'User city is Paris', {
      claim: { subject: 'user', predicate: 'city', value: 'Paris', scope: 'global' },
      provenance: { source: 'inference' },
    });

    const bySubject = await graph.conflicts({ subject: 'user' });
    const noMatch = await graph.conflicts({ subject: 'org' });
    expect(bySubject.length).toBe(1);
    expect(noMatch.length).toBe(0);
  });

  it('resolveConflict("supersede") activates quarantined memory and supersedes existing', async () => {
    const graph = createTestGraph();
    const old = await graph.store('a', 'Plan is A', {
      claim: { subject: 'project', predicate: 'plan', value: 'A', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const newer = await graph.store('a', 'Plan is B', {
      claim: { subject: 'project', predicate: 'plan', value: 'B', scope: 'global' },
      provenance: { source: 'inference' },
    });
    const pending = await graph.pendingConflicts();

    await graph.resolveConflict(pending[0].id, { action: 'supersede' });

    expect(graph._byId(newer.id).status).toBe('active');
    expect(graph._byId(old.id).status).toBe('superseded');
  });

  it('resolveConflict("reject") archives quarantined memory', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Diet is vegan', {
      claim: { subject: 'user', predicate: 'diet', value: 'vegan', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const newer = await graph.store('a', 'Diet is keto', {
      claim: { subject: 'user', predicate: 'diet', value: 'keto', scope: 'global' },
      provenance: { source: 'inference' },
    });
    const pending = await graph.pendingConflicts();

    await graph.resolveConflict(pending[0].id, { action: 'reject' });

    expect(graph._byId(newer.id)).toBeUndefined();
    const archive = await graph.storage.loadArchive();
    expect(archive.some(m => m.id === newer.id)).toBe(true);
  });

  it('resolveConflict("keep_both") activates both memories and resolves conflict', async () => {
    const graph = createTestGraph();
    const old = await graph.store('a', 'Editor is vim', {
      claim: { subject: 'user', predicate: 'editor', value: 'vim', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const newer = await graph.store('a', 'Editor is emacs', {
      claim: { subject: 'user', predicate: 'editor', value: 'emacs', scope: 'global' },
      provenance: { source: 'inference' },
    });
    const [conflict] = await graph.pendingConflicts();

    await graph.resolveConflict(conflict.id, { action: 'keep_both' });

    expect(graph._byId(old.id).status).toBe('active');
    expect(graph._byId(newer.id).status).toBe('active');
    const unresolved = await graph.pendingConflicts();
    expect(unresolved.length).toBe(0);
  });

  it('supersede event emitted', async () => {
    const graph = createTestGraph();
    const events = [];
    graph.on('supersede', e => events.push(e));

    const old = await graph.store('a', 'Office is NYC', {
      claim: { subject: 'org', predicate: 'office', value: 'NYC', scope: 'global' },
      provenance: { source: 'inference' },
    });
    const newer = await graph.store('a', 'Office is SF', {
      claim: { subject: 'org', predicate: 'office', value: 'SF', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ newId: newer.id, oldId: old.id, reason: 'trust_gated' });
  });

  it('conflict:pending event emitted', async () => {
    const graph = createTestGraph();
    const events = [];
    graph.on('conflict:pending', e => events.push(e));

    const old = await graph.store('a', 'Country is US', {
      claim: { subject: 'user', predicate: 'country', value: 'US', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const newer = await graph.store('a', 'Country is UK', {
      claim: { subject: 'user', predicate: 'country', value: 'UK', scope: 'global' },
      provenance: { source: 'inference' },
    });

    expect(events.length).toBe(1);
    expect(events[0].newId).toBe(newer.id);
    expect(events[0].existingId).toBe(old.id);
    expect(events[0].newTrust).toBeLessThan(events[0].existingTrust);
  });

  it('existing evolve() still works (backward compat)', async () => {
    const graph = createTestGraph();
    const result = await graph.evolve('a', 'Evolve stores this memory', { category: 'fact' });
    expect(result.stored).toBe(true);
    expect(graph._byId(result.id)).toBeTruthy();
  });

  it('store without claims does no conflict checking (backward compat)', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'No claim memory');
    const pending = await graph.pendingConflicts();
    expect(pending.length).toBe(0);
  });

  it('exact-value duplicate corroborates and does not create new node', async () => {
    const graph = createTestGraph();
    const claim = { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' };
    const first = await graph.store('a', 'Timezone is UTC', { claim });
    const second = await graph.store('a', 'Timezone still UTC', { claim });

    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(graph.memories.length).toBe(1);
    expect(graph._byId(first.id).provenance.corroboration).toBe(2);
  });
});
