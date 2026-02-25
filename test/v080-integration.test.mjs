import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createGraph(config = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config: { linkThreshold: 0.99, ...config },
  });
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('v0.8 Trustworthy Memory - Integration', () => {
  it('Full lifecycle: store -> conflict -> supersede -> consolidate', async () => {
    const graph = createGraph();

    const a = await graph.store('a', 'User budget is $500', {
      claim: { subject: 'user', predicate: 'budget_is', value: '$500', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const b = await graph.store('a', 'User budget is $750', {
      claim: { subject: 'user', predicate: 'budget_is', value: '$750', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const memA = graph._byId(a.id);
    const memB = graph._byId(b.id);
    expect(memA.status).toBe('superseded');
    expect(memB.status).toBe('active');
    expect(memB.supersedes).toContain(a.id);

    const activeOnly = await graph.search('a', 'budget', { includeAll: false });
    expect(activeOnly.map(r => r.id)).toEqual([b.id]);

    const all = await graph.search('a', 'budget', { includeAll: true });
    const ids = new Set(all.map(r => r.id));
    expect(ids.has(a.id)).toBe(true);
    expect(ids.has(b.id)).toBe(true);

    const report = await graph.consolidate({ compressAge: 99999 });
    expect(report.before.total).toBe(2);
    expect(report.after.total).toBeLessThanOrEqual(2);
  });

  it('Trust gating blocks low-trust override', async () => {
    const graph = createGraph();

    const original = await graph.store('a', 'User is vegetarian', {
      claim: { subject: 'user', predicate: 'diet', value: 'vegetarian', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });
    const conflicting = await graph.store('a', 'User eats meat', {
      claim: { subject: 'user', predicate: 'diet', value: 'eats_meat', scope: 'global' },
      provenance: { source: 'document' },
    });

    expect(graph._byId(original.id).status).toBe('active');
    expect(graph._byId(conflicting.id).status).toBe('quarantined');

    const [pending] = await graph.pendingConflicts();
    expect(pending).toBeTruthy();

    await graph.resolveConflict(pending.id, { action: 'reject' });

    expect(graph._byId(conflicting.id)).toBeUndefined();
    const result = await graph.search('a', 'vegetarian', { includeAll: false });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(original.id);
  });

  it('Feedback loop: dispute + corroborate', async () => {
    const graph = createGraph();

    const disputed = await graph.store('a', 'Likely preference inferred from behavior', {
      provenance: { source: 'inference' },
    });
    graph._byId(disputed.id).created_at = daysAgo(1100);
    graph._byId(disputed.id).updated_at = daysAgo(1100);

    await graph.dispute(disputed.id, { reason: 'wrong signal 1' });
    await graph.dispute(disputed.id, { reason: 'wrong signal 2' });
    await graph.dispute(disputed.id, { reason: 'wrong signal 3' });

    const disputedMem = graph._byId(disputed.id);
    expect(disputedMem.status).toBe('disputed');
    expect(disputedMem.provenance.trust).toBeLessThan(0.3);

    const corroborated = await graph.store('a', 'User preference confirmed in follow-up', {
      provenance: { source: 'inference' },
    });
    const beforeTrust = graph._byId(corroborated.id).provenance.trust;
    const beforeConfidence = graph._byId(corroborated.id).confidence ?? 0.5;
    for (let i = 0; i < 5; i++) await graph.corroborate(corroborated.id);

    const corroboratedMem = graph._byId(corroborated.id);
    expect(corroboratedMem.provenance.trust).toBeGreaterThan(beforeTrust);
    expect(corroboratedMem.confidence).toBeGreaterThan(beforeConfidence);
  });

  it('Budget-aware context assembly', async () => {
    const graph = createGraph();
    for (let i = 0; i < 20; i++) {
      await graph.store('a', `project budget memo ${i} ${'detail '.repeat(90 + i)}`, {
        category: 'fact',
        importance: 0.3 + (i * 0.01),
      });
    }

    const limited = await graph.context('a', 'budget', { maxMemories: 15, maxTokens: 500 });
    expect(limited.count).toBeLessThan(15);
    expect(limited.tokenEstimate).toBeLessThanOrEqual(500);

    const full = await graph.context('a', 'budget', { maxMemories: 15 });
    expect(full.count).toBe(8);
  });

  it('consolidate() full cycle', async () => {
    const graph = createGraph({ deleteThreshold: 0.6 });

    const dupA = await graph.store('a', 'Server timeout is 30 seconds canonical', {
      provenance: { source: 'user_explicit' },
      importance: 0.9,
    });
    const dupB = await graph.store('a', 'Server timeout is thirty seconds variant', {
      provenance: { source: 'inference' },
      importance: 0.6,
    });
    graph._byId(dupA.id).embedding = [1, 0, 0];
    graph._byId(dupB.id).embedding = [0.98, 0.02, 0];

    const cHigh = await graph.store('a', 'API base URL is /v2', {
      claim: { subject: 'api', predicate: 'base_url', value: '/v2', scope: 'global' },
      provenance: { source: 'user_explicit' },
      importance: 0.9,
    });
    const cLow = await graph.store('a', 'API base URL is /v1', {
      claim: { subject: 'api', predicate: 'base_url', value: '/v1', scope: 'global' },
      provenance: { source: 'document' },
      importance: 0.6,
    });
    graph._byId(cHigh.id).status = 'active';
    graph._byId(cHigh.id).superseded_by = undefined;
    graph._byId(cLow.id).status = 'active';
    graph._byId(cLow.id).superseded_by = undefined;

    const old1 = await graph.store('a', 'Old note one', { importance: 0.05 });
    const old2 = await graph.store('a', 'Old note two', { importance: 0.05 });
    const old3 = await graph.store('a', 'Old note three', { importance: 0.05 });
    for (const id of [old1.id, old2.id, old3.id]) {
      graph._byId(id).created_at = daysAgo(500);
      graph._byId(id).updated_at = daysAgo(500);
    }

    await graph.store('a', 'Recent memory one', { importance: 0.9 });
    await graph.store('a', 'Recent memory two', { importance: 0.9 });
    await graph.store('a', 'Recent memory three', { importance: 0.9 });

    const report = await graph.consolidate({ dedupThreshold: 0.95, compressAge: 30, pruneAge: 90 });

    expect(report.before.total).toBe(10);
    expect(report.deduplicated).toBeGreaterThanOrEqual(1);
    expect(report.contradictions.resolved).toBeGreaterThanOrEqual(1);
    expect(report.pruned.decayed).toBeGreaterThanOrEqual(3);
    expect(graph._byId(dupB.id).status).toBe('superseded');
    expect(graph._byId(cLow.id).status).toBe('superseded');
    expect(graph._byId(cHigh.id).status).toBe('active');
  });

  it('Re-ranking changes result order', async () => {
    const graph = createGraph();

    const a = await graph.store('a', 'project alpha budget canonical', {
      provenance: { source: 'inference' },
      importance: 0.2,
    });
    const b = await graph.store('a', 'project alpha overview', {
      provenance: { source: 'user_explicit' },
      importance: 0.9,
    });

    const reranked = await graph.search('a', 'project alpha budget', { rerank: true });
    expect(reranked[0].id).toBe(b.id);

    const raw = await graph.search('a', 'project alpha budget', { rerank: false });
    expect(raw[0].id).toBe(a.id);
  });
});
