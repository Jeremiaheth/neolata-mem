import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createGraph(config = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config,
  });
}

describe('Quarantine Lane', () => {
  it('blocked trust supersession quarantines new memory with metadata and hides it from default search', async () => {
    const graph = createGraph();
    await graph.store('a', 'Timezone is UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const lowTrust = await graph.store('a', 'Timezone is PST', {
      claim: { subject: 'user', predicate: 'timezone', value: 'PST', scope: 'global' },
      provenance: { source: 'inference' },
    });

    const mem = graph._byId(lowTrust.id);
    expect(mem.status).toBe('quarantined');
    expect(mem.quarantine.reason).toBe('trust_insufficient');
    expect(mem.quarantine.created_at).toBeTypeOf('string');

    const results = await graph.search('a', 'timezone');
    expect(results.some(r => r.id === lowTrust.id)).toBe(false);
  });

  it('includeQuarantined:true returns quarantined memories', async () => {
    const graph = createGraph();
    const quarantined = await graph.store('a', 'Manually quarantined via store', { quarantine: true });

    const results = await graph.search('a', 'quarantined', { includeQuarantined: true });
    expect(results.some(r => r.id === quarantined.id)).toBe(true);
  });

  it('listQuarantined returns only quarantined memories', async () => {
    const graph = createGraph();
    const active = await graph.store('a', 'Active memory');
    const q1 = await graph.store('a', 'Q one', { quarantine: true });
    const q2 = await graph.store('b', 'Q two', { quarantine: true });

    const all = await graph.listQuarantined({ limit: 10 });
    expect(all.every(m => m.status === 'quarantined')).toBe(true);
    expect(all.some(m => m.id === q1.id)).toBe(true);
    expect(all.some(m => m.id === q2.id)).toBe(true);
    expect(all.some(m => m.id === active.id)).toBe(false);

    const byAgent = await graph.listQuarantined({ agent: 'a', limit: 10 });
    expect(byAgent.every(m => m.agent === 'a')).toBe(true);
  });

  it('reviewQuarantine activate flips status to active', async () => {
    const graph = createGraph();
    const stored = await graph.store('a', 'Review activation', { quarantine: true });

    const out = await graph.reviewQuarantine(stored.id, { action: 'activate', reason: 'approved' });
    expect(out.reviewed).toBe(true);
    expect(graph._byId(stored.id).status).toBe('active');
    expect(graph._byId(stored.id).quarantine.resolution).toBe('activated');
  });

  it('reviewQuarantine reject archives/removes memory', async () => {
    const graph = createGraph();
    const stored = await graph.store('a', 'Review reject', { quarantine: true });

    await graph.reviewQuarantine(stored.id, { action: 'reject', reason: 'invalid' });
    expect(graph._byId(stored.id)).toBeUndefined();
    const archive = await graph.storage.loadArchive();
    expect(archive.some(m => m.id === stored.id)).toBe(true);
  });

  it('schema require_review quarantines conflict with metadata', async () => {
    const graph = createGraph({
      predicateSchemas: {
        timezone: { cardinality: 'single', conflictPolicy: 'require_review' },
      },
    });

    await graph.store('a', 'Timezone is UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
    });
    const newer = await graph.store('a', 'Timezone is CET', {
      claim: { subject: 'user', predicate: 'timezone', value: 'CET', scope: 'global' },
    });

    const mem = graph._byId(newer.id);
    expect(mem.status).toBe('quarantined');
    expect(mem.quarantine.reason).toBe('predicate_requires_review');
    expect(mem.quarantine.created_at).toBeTypeOf('string');
  });

  it('manual quarantine() sets metadata on active memory', async () => {
    const graph = createGraph();
    const stored = await graph.store('a', 'Operator flagged memory');

    const result = await graph.quarantine(stored.id, { reason: 'manual', details: 'flagged by operator' });
    expect(result.status).toBe('quarantined');
    expect(graph._byId(stored.id).quarantine.reason).toBe('manual');
    expect(graph._byId(stored.id).quarantine.details).toBe('flagged by operator');
  });

  it('store opts.quarantine=true manually quarantines new memory', async () => {
    const graph = createGraph();
    const stored = await graph.store('a', 'Needs manual review', { quarantine: true });

    const mem = graph._byId(stored.id);
    expect(mem.status).toBe('quarantined');
    expect(mem.quarantine.reason).toBe('manual');
  });

  it("onConflict:'keep_active' preserves backward-compatible keep-active behavior", async () => {
    const graph = createGraph();
    await graph.store('a', 'Language is English', {
      claim: { subject: 'user', predicate: 'language', value: 'en', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const newer = await graph.store('a', 'Language is Spanish', {
      claim: { subject: 'user', predicate: 'language', value: 'es', scope: 'global' },
      provenance: { source: 'inference' },
      onConflict: 'keep_active',
    });

    const mem = graph._byId(newer.id);
    expect(mem.status).toBe('active');
    const pending = await graph.pendingConflicts();
    expect(pending.length).toBe(1);
  });

  it('consolidate pruneQuarantined prunes old unaccessed quarantined memories', async () => {
    const graph = createGraph();
    const old = await graph.store('a', 'Old quarantine prune target', { quarantine: true });
    const recent = await graph.store('a', 'Recent quarantine keep target', { quarantine: true });

    const oldMem = graph._byId(old.id);
    const recentMem = graph._byId(recent.id);
    oldMem.quarantine.created_at = new Date(Date.now() - (45 * 24 * 60 * 60 * 1000)).toISOString();
    oldMem.updated_at = oldMem.quarantine.created_at;
    oldMem.accessCount = 0;

    recentMem.quarantine.created_at = new Date(Date.now() - (5 * 24 * 60 * 60 * 1000)).toISOString();
    recentMem.updated_at = recentMem.quarantine.created_at;
    recentMem.accessCount = 0;

    const report = await graph.consolidate({ pruneQuarantined: true, quarantineMaxAgeDays: 30, pruneSuperseded: false });

    expect(report.pruned.quarantined).toBeGreaterThanOrEqual(1);
    expect(graph._byId(old.id)).toBeUndefined();
    expect(graph._byId(recent.id)).toBeTruthy();
  });
});
