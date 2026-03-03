import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/index.mjs';

function createCliMemory() {
  return createMemory({ storage: { type: 'memory' } });
}

function formatCliSearchLine(result) {
  return `[${result.score.toFixed(3)}] [${result.agent}/${result.category}] ${result.memory}`;
}

describe('CLI workflows', () => {
  it('store workflow - store returns id and link count', async () => {
    const mem = createCliMemory();
    const result = await mem.store('cli-agent', 'Store workflow memory');
    assert.match(result.id, /^mem_/);
    assert.equal(typeof result.links, 'number');
  });

  it('search workflow - search returns formatted results', async () => {
    const mem = createCliMemory();
    await mem.store('cli-agent', 'Redis cache on port 6379');
    const results = await mem.search('cli-agent', 'Redis');
    assert.ok(results.length >= 1);
    const line = formatCliSearchLine(results[0]);
    assert.match(line, /^\[\d\.\d{3}\] \[cli-agent\/fact\] /);
    assert.ok(line.includes('Redis cache on port 6379'));
  });

  it('search-all workflow - searchAll returns cross-agent results', async () => {
    const mem = createCliMemory();
    await mem.store('agent-a', 'shared topic knowledge');
    await mem.store('agent-b', 'shared topic expansion');
    const results = await mem.searchAll('shared topic');
    const agents = new Set(results.map(r => r.agent));
    assert.ok(agents.has('agent-a'));
    assert.ok(agents.has('agent-b'));
  });

  it('evolve workflow - evolve returns actions array', async () => {
    const mem = createCliMemory();
    const result = await mem.evolve('cli-agent', 'new evolving fact');
    assert.ok(Array.isArray(result.actions));
    assert.equal(result.actions[0].type, 'stored');
    assert.equal(result.stored, true);
  });

  it('links workflow - links returns memory with connections', async () => {
    const mem = createCliMemory();
    const a = await mem.store('cli-agent', 'Node A');
    const b = await mem.store('cli-agent', 'Node B');
    const nodeA = mem.memories.find(m => m.id === a.id);
    const nodeB = mem.memories.find(m => m.id === b.id);
    nodeA.links = [{ id: b.id, similarity: 0.9 }];
    nodeB.links = [{ id: a.id, similarity: 0.9 }];

    const result = await mem.links(a.id);
    assert.equal(result.id, a.id);
    assert.equal(result.links.length, 1);
    assert.equal(result.links[0].id, b.id);
  });

  it('traverse workflow - traverse returns nodes with hop info', async () => {
    const mem = createCliMemory();
    const a = await mem.store('cli-agent', 'Traverse A');
    const b = await mem.store('cli-agent', 'Traverse B');
    const c = await mem.store('cli-agent', 'Traverse C');
    mem.memories.find(m => m.id === a.id).links = [{ id: b.id, similarity: 0.9 }];
    mem.memories.find(m => m.id === b.id).links = [{ id: a.id, similarity: 0.9 }, { id: c.id, similarity: 0.8 }];
    mem.memories.find(m => m.id === c.id).links = [{ id: b.id, similarity: 0.8 }];

    const result = await mem.traverse(a.id, 2);
    assert.equal(result.start.id, a.id);
    assert.ok(result.nodes.some(n => n.id === a.id && n.hop === 0));
    assert.ok(result.nodes.some(n => n.id === b.id && n.hop === 1));
    assert.ok(result.nodes.some(n => n.id === c.id && n.hop === 2));
  });

  it('clusters workflow - clusters returns connected components', async () => {
    const mem = createCliMemory();
    const a = await mem.store('cli-agent', 'Cluster A', { tags: ['x'] });
    const b = await mem.store('cli-agent', 'Cluster B', { tags: ['x'] });
    await mem.store('cli-agent', 'Orphan');
    mem.memories.find(m => m.id === a.id).links = [{ id: b.id, similarity: 0.9 }];
    mem.memories.find(m => m.id === b.id).links = [{ id: a.id, similarity: 0.9 }];

    const clusters = await mem.clusters(2);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].size, 2);
  });

  it('path workflow - path between linked memories', async () => {
    const mem = createCliMemory();
    const a = await mem.store('cli-agent', 'Path A');
    const b = await mem.store('cli-agent', 'Path B');
    const c = await mem.store('cli-agent', 'Path C');
    mem.memories.find(m => m.id === a.id).links = [{ id: b.id, similarity: 0.9 }];
    mem.memories.find(m => m.id === b.id).links = [{ id: a.id, similarity: 0.9 }, { id: c.id, similarity: 0.9 }];
    mem.memories.find(m => m.id === c.id).links = [{ id: b.id, similarity: 0.9 }];

    const path = await mem.path(a.id, c.id);
    assert.equal(path.found, true);
    assert.equal(path.hops, 2);
    assert.deepEqual(path.path.map(p => p.id), [a.id, b.id, c.id]);
  });

  it('decay workflow - decay returns report object', async () => {
    const mem = createCliMemory();
    await mem.store('cli-agent', 'Decay target');
    const report = await mem.decay({ dryRun: true });
    assert.equal(typeof report.total, 'number');
    assert.ok(Array.isArray(report.archived));
    assert.ok(Array.isArray(report.deleted));
  });

  it('health workflow - health returns full report', async () => {
    const mem = createCliMemory();
    await mem.store('a', 'health one');
    await mem.store('b', 'health two');
    const report = await mem.health();
    assert.equal(report.total, 2);
    assert.equal(typeof report.totalLinks, 'number');
    assert.equal(typeof report.avgStrength, 'number');
    assert.equal(typeof report.distribution, 'object');
  });

  it('context workflow - context returns formatted markdown', async () => {
    const mem = createCliMemory();
    await mem.store('cli-agent', 'Decision to use Redis', { category: 'decision' });
    const result = await mem.context('cli-agent', 'Redis');
    assert.ok(result.context.includes('## Relevant Memory Context'));
    assert.ok(result.context.includes('### Decisions'));
    assert.ok(result.context.includes('Decision to use Redis'));
  });

  it('store with tags - tags are passed through', async () => {
    const mem = createCliMemory();
    await mem.store('cli-agent', 'Tagged workflow memory', { tags: ['alpha', 'beta'] });
    const [found] = await mem.search('cli-agent', 'Tagged workflow memory');
    assert.deepEqual(found.tags, ['alpha', 'beta']);
  });

  it('search with no results - returns empty array', async () => {
    const mem = createCliMemory();
    await mem.store('cli-agent', 'Only indexed phrase');
    const results = await mem.search('cli-agent', 'definitelyabsenttoken');
    assert.deepEqual(results, []);
  });

  it('multiple stores then health check - counts accurate', async () => {
    const mem = createCliMemory();
    await mem.store('agent-1', 'count one');
    await mem.store('agent-1', 'count two');
    await mem.store('agent-2', 'count three');
    const report = await mem.health();
    assert.equal(report.total, 3);
    assert.equal(report.byAgent['agent-1'], 2);
    assert.equal(report.byAgent['agent-2'], 1);
  });

  it('full lifecycle: store -> search -> evolve -> decay -> health', async () => {
    const mem = createCliMemory();
    const stored = await mem.store('lifecycle-agent', 'Lifecycle memory');
    const searched = await mem.search('lifecycle-agent', 'Lifecycle');
    const evolved = await mem.evolve('lifecycle-agent', 'Lifecycle memory updated');
    const decayed = await mem.decay({ dryRun: true });
    const health = await mem.health();

    assert.match(stored.id, /^mem_/);
    assert.ok(searched.length >= 1);
    assert.ok(Array.isArray(evolved.actions));
    assert.equal(typeof decayed.total, 'number');
    assert.ok(health.total >= 2);
  });
});
