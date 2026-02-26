import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createTestGraph(config = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config,
  });
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function memory({
  id,
  text,
  status = 'active',
  embedding = null,
  importance = 0.5,
  trust = 0.5,
  source = 'inference',
  category = 'fact',
  claim,
  created_at = new Date().toISOString(),
  updated_at = created_at,
}) {
  return {
    id,
    agent: 'a',
    memory: text,
    category,
    importance,
    tags: [],
    links: [],
    embedding,
    status,
    provenance: { source, trust, corroboration: 1 },
    created_at,
    updated_at,
    ...(claim ? { claim } : {}),
  };
}

function seed(graph, mems) {
  graph.memories = mems;
  graph.loaded = true;
  graph._rebuildIndexes();
}

describe('Consolidation', () => {
  it('consolidate() deduplicates near-identical memories', async () => {
    const graph = createTestGraph();
    seed(graph, [
      memory({ id: 'mem_a', text: 'duplicate alpha', embedding: [1, 0, 0], trust: 0.9, source: 'user_explicit' }),
      memory({ id: 'mem_b', text: 'duplicate alpha variant', embedding: [0.99, 0.01, 0], trust: 0.4, source: 'inference' }),
    ]);

    const report = await graph.consolidate({ dedupThreshold: 0.95, compressAge: 99999 });
    expect(report.deduplicated).toBeGreaterThan(0);
    expect(graph._byId('mem_b').status).toBe('superseded');
    expect(graph._byId('mem_b').superseded_by).toBe('mem_a');
  });

  it('consolidate() resolves claim contradictions', async () => {
    const graph = createTestGraph();
    seed(graph, [
      memory({
        id: 'mem_new',
        text: 'Service now uses 8080',
        trust: 0.9,
        claim: { subject: 'service', predicate: 'port', value: '8080', exclusive: true, scope: 'global' },
      }),
      memory({
        id: 'mem_old',
        text: 'Service uses 3000',
        trust: 0.3,
        claim: { subject: 'service', predicate: 'port', value: '3000', exclusive: true, scope: 'global' },
      }),
    ]);

    const report = await graph.consolidate({ compressAge: 99999 });
    expect(report.contradictions.resolved).toBeGreaterThan(0);
    expect(graph._byId('mem_old').status).toBe('superseded');
    expect(graph._byId('mem_old').superseded_by).toBe('mem_new');
  });

  it('consolidate() corroborates cross-source similar memories', async () => {
    const graph = createTestGraph();
    const bY = Math.sqrt(1 - (0.92 * 0.92));
    seed(graph, [
      memory({ id: 'mem_hi', text: 'api uses jwt', embedding: [1, 0, 0], trust: 0.8, source: 'document' }),
      memory({ id: 'mem_peer', text: 'jwt is used by api', embedding: [0.92, bY, 0], trust: 0.6, source: 'tool_output' }),
    ]);

    const report = await graph.consolidate({ dedupThreshold: 0.95, compressAge: 99999 });
    expect(report.corroborated).toBeGreaterThan(0);
    expect(graph._byId('mem_hi').provenance.corroboration).toBeGreaterThan(1);
  });

  it('consolidate() prunes old superseded memories', async () => {
    const graph = createTestGraph();
    seed(graph, [
      memory({ id: 'mem_sup_old', text: 'old superseded', status: 'superseded', created_at: daysAgo(120), updated_at: daysAgo(120) }),
      memory({ id: 'mem_active', text: 'still active' }),
    ]);

    const report = await graph.consolidate({ pruneAge: 90, compressAge: 99999 });
    expect(report.pruned.superseded).toBe(1);
    expect(graph._byId('mem_sup_old')).toBeUndefined();
  });

  it('consolidate() prunes disputed low-trust memories', async () => {
    const graph = createTestGraph();
    seed(graph, [
      memory({ id: 'mem_disputed', text: 'questionable fact', status: 'disputed', trust: 0.1 }),
      memory({ id: 'mem_active', text: 'normal fact', trust: 0.7 }),
    ]);

    const report = await graph.consolidate({ compressAge: 99999 });
    expect(report.pruned.disputed).toBe(1);
    expect(graph._byId('mem_disputed')).toBeUndefined();
  });

  it('consolidate() prunes decayed memories', async () => {
    const graph = createTestGraph({ deleteThreshold: 0.9 });
    seed(graph, [
      memory({ id: 'mem_decay', text: 'stale low importance', importance: 0.1, created_at: daysAgo(365), updated_at: daysAgo(365) }),
    ]);

    const report = await graph.consolidate({ compressAge: 99999 });
    expect(report.pruned.decayed).toBe(1);
    expect(graph._byId('mem_decay')).toBeUndefined();
  });

  it('consolidate() scoped to agent only affects that agent', async () => {
    const graph = createTestGraph();
    seed(graph, [
      memory({ id: 'mem_a1', text: 'agent a dup 1', embedding: [1, 0, 0], trust: 0.9 }),
      memory({ id: 'mem_a2', text: 'agent a dup 2', embedding: [0.99, 0.01, 0], trust: 0.2 }),
      { ...memory({ id: 'mem_b1', text: 'agent b fact', embedding: [1, 0, 0], trust: 0.5 }), agent: 'b' },
      { ...memory({ id: 'mem_b2', text: 'agent b fact copy', embedding: [0.99, 0.01, 0], trust: 0.3 }), agent: 'b' },
    ]);

    const report = await graph.consolidate({ agent: 'a', dedupThreshold: 0.95, compressAge: 99999 });
    expect(report.deduplicated).toBeGreaterThan(0);
    // Agent a's duplicate should be superseded
    expect(graph._byId('mem_a2').status).toBe('superseded');
    // Agent b's duplicate should be untouched
    expect(graph._byId('mem_b2').status).toBe('active');
    // Report counts only agent a's memories
    expect(report.before.total).toBe(2);
  });

  it('dryRun: true returns report without mutations', async () => {
    const graph = createTestGraph();
    seed(graph, [
      memory({ id: 'mem_a', text: 'duplicate alpha', embedding: [1, 0, 0], trust: 0.9 }),
      memory({ id: 'mem_b', text: 'duplicate alpha v2', embedding: [0.99, 0.01, 0], trust: 0.2 }),
      memory({ id: 'mem_c', text: 'old superseded', status: 'superseded', created_at: daysAgo(200), updated_at: daysAgo(200) }),
    ]);
    const before = JSON.stringify(graph.memories);

    const report = await graph.consolidate({ dryRun: true, dedupThreshold: 0.95, pruneAge: 90 });
    const after = JSON.stringify(graph.memories);

    expect(report.deduplicated).toBeGreaterThan(0);
    expect(before).toBe(after);
  });
});

