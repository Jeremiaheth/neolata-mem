import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createTestGraph(opts = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config: { linkThreshold: 0.1, ...(opts.config || {}) },
    ...opts,
  });
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('Search reranking', () => {
  let graph;
  let ids;

  beforeEach(async () => {
    graph = createTestGraph();
    const a = await graph.store('a', 'alpha beta gamma legacy', {
      importance: 0.1,
      provenance: { source: 'inference' },
    });
    const b = await graph.store('a', 'alpha beta premium', {
      importance: 1.0,
      provenance: { source: 'user_explicit' },
    });
    const c = await graph.store('a', 'alpha signal fresh', {
      importance: 0.6,
      provenance: { source: 'document' },
    });
    const d = await graph.store('a', 'delta epsilon zeta archive', {
      importance: 0.3,
      provenance: { source: 'inference' },
    });
    const e = await graph.store('a', 'delta epsilon trusted', {
      importance: 0.9,
      provenance: { source: 'tool_output' },
    });

    ids = { lowTrustHighSim: a.id, highTrustLowerSim: b.id, freshest: c.id, q2LowTrust: d.id, q2HighTrust: e.id };

    graph._byId(ids.lowTrustHighSim).updated_at = daysAgo(1200);
    graph._byId(ids.lowTrustHighSim).created_at = daysAgo(1200);
    graph._byId(ids.highTrustLowerSim).updated_at = daysAgo(2);
    graph._byId(ids.highTrustLowerSim).created_at = daysAgo(2);
    graph._byId(ids.freshest).updated_at = daysAgo(0);
    graph._byId(ids.freshest).created_at = daysAgo(0);
    graph._byId(ids.q2LowTrust).updated_at = daysAgo(800);
    graph._byId(ids.q2LowTrust).created_at = daysAgo(800);
    graph._byId(ids.q2HighTrust).updated_at = daysAgo(1);
    graph._byId(ids.q2HighTrust).created_at = daysAgo(1);
  });

  it('default reranking reorders results by confidence over higher similarity', async () => {
    const results = await graph.search('a', 'alpha beta gamma', { limit: 5 });
    expect(results[0].id).toBe(ids.highTrustLowerSim);
  });

  it('compositeScore and rankingSignals are present', async () => {
    const results = await graph.search('a', 'alpha beta gamma', { limit: 5 });
    expect(typeof results[0].compositeScore).toBe('number');
    expect(results[0].rankingSignals).toBeTruthy();
    expect(typeof results[0].rankingSignals.relevance).toBe('number');
    expect(typeof results[0].rankingSignals.confidence).toBe('number');
    expect(typeof results[0].rankingSignals.recency).toBe('number');
    expect(typeof results[0].rankingSignals.importance).toBe('number');
  });

  it('rerank: false keeps raw similarity ordering', async () => {
    const results = await graph.search('a', 'alpha beta gamma', { limit: 5, rerank: false });
    expect(results[0].id).toBe(ids.lowTrustHighSim);
  });

  it('custom weights shift ranking (all recency)', async () => {
    const results = await graph.search('a', 'alpha beta gamma', {
      limit: 5,
      rerank: { relevance: 0, confidence: 0, recency: 1, importance: 0 },
    });
    expect(results[0].id).toBe(ids.freshest);
  });

  it('superseded memories are filtered by default', async () => {
    graph._byId(ids.highTrustLowerSim).status = 'superseded';
    const results = await graph.search('a', 'alpha beta gamma');
    const resultIds = new Set(results.map(r => r.id));
    expect(resultIds.has(ids.highTrustLowerSim)).toBe(false);
  });

  it('includeAll: true includes all statuses', async () => {
    graph._byId(ids.highTrustLowerSim).status = 'superseded';
    const results = await graph.search('a', 'alpha beta gamma', { includeAll: true });
    const resultIds = new Set(results.map(r => r.id));
    expect(resultIds.has(ids.highTrustLowerSim)).toBe(true);
  });

  it('searchMany with rerank works per query', async () => {
    const batches = await graph.searchMany('a', ['alpha beta gamma', 'delta epsilon zeta'], { limit: 3 });
    expect(batches[0].results[0].id).toBe(ids.highTrustLowerSim);
    expect(batches[1].results[0].id).toBe(ids.q2HighTrust);
    expect(typeof batches[0].results[0].compositeScore).toBe('number');
    expect(batches[0].results[0].rankingSignals).toBeTruthy();
    expect(typeof batches[1].results[0].compositeScore).toBe('number');
    expect(batches[1].results[0].rankingSignals).toBeTruthy();
  });
});
