import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../src/index.mjs';

function wireBidirectional(mem, idA, idB, similarity = 0.9) {
  const a = mem.memories.find(m => m.id === idA);
  const b = mem.memories.find(m => m.id === idB);
  if (!a || !b) return;
  a.links = a.links || [];
  b.links = b.links || [];
  if (!a.links.find(l => l.id === idB)) a.links.push({ id: idB, similarity });
  if (!b.links.find(l => l.id === idA)) b.links.push({ id: idA, similarity });
}

describe('Integration - multi-agent workflows', () => {
  it('Three agents store memories, searchAll finds all', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    await mem.store('agent-a', 'shared integration keyword');
    await mem.store('agent-b', 'shared integration keyword');
    await mem.store('agent-c', 'shared integration keyword');

    const results = await mem.searchAll('shared integration keyword');
    const agents = new Set(results.map(r => r.agent));
    assert.equal(results.length, 3);
    assert.deepEqual(agents, new Set(['agent-a', 'agent-b', 'agent-c']));
  });

  it('Store 10 memories, verify health count=10', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    for (let i = 0; i < 10; i += 1) {
      await mem.store('agent-1', `memory-${i}`);
    }

    const report = await mem.health();
    assert.equal(report.total, 10);
  });

  it('Store -> evolve -> decay lifecycle for single agent', async () => {
    const mem = createMemory({
      storage: { type: 'memory' },
      graph: { archiveThreshold: 0.95, deleteThreshold: 0.01 },
    });

    await mem.store('solo', 'initial lifecycle memory', { importance: 0.6 });
    const evolved = await mem.evolve('solo', 'evolved lifecycle memory', { importance: 0.6 });
    const decay = await mem.decay();

    assert.equal(evolved.stored, true);
    assert.equal(decay.total, 2);
    assert.equal(decay.archived.length, 2);
  });

  it('Cross-agent link discovery via traverse', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const a = await mem.store('agent-a', 'a node');
    const b = await mem.store('agent-b', 'b node');
    wireBidirectional(mem, a.id, b.id);

    const result = await mem.traverse(a.id, 1);
    assert.ok(result);
    assert.equal(result.reached, 2);
    assert.ok(result.nodes.some(n => n.id === b.id && n.agent === 'agent-b'));
  });

  it('Multiple agents, clusters form within agents', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const a1 = await mem.store('agent-a', 'a1');
    const a2 = await mem.store('agent-a', 'a2');
    const b1 = await mem.store('agent-b', 'b1');
    const b2 = await mem.store('agent-b', 'b2');

    wireBidirectional(mem, a1.id, a2.id);
    wireBidirectional(mem, b1.id, b2.id);

    const clusters = await mem.clusters(2);
    assert.equal(clusters.length, 2);
    assert.ok(clusters.some(c => c.agents['agent-a'] === 2));
    assert.ok(clusters.some(c => c.agents['agent-b'] === 2));
  });

  it('Context briefing pulls from linked memories', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const direct = await mem.store('agent-a', 'redis overview keyword');
    const linked = await mem.store('agent-a', 'ttl settings detail');
    wireBidirectional(mem, direct.id, linked.id);

    const result = await mem.context('agent-a', 'redis overview keyword', { maxMemories: 5 });
    assert.ok(result.memories.some(m => m.id === direct.id));
    assert.ok(result.memories.some(m => m.id === linked.id && m.source === 'linked'));
  });

  it('Timeline shows correct date grouping', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const today = await mem.store('agent-a', 'today note');
    const older = await mem.store('agent-a', 'older note');

    const todayMem = mem.memories.find(m => m.id === today.id);
    const olderMem = mem.memories.find(m => m.id === older.id);
    todayMem.created_at = new Date().toISOString();
    olderMem.created_at = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();

    const timeline = await mem.timeline('agent-a', 7);
    assert.equal(timeline.total, 2);
    assert.equal(Object.keys(timeline.dates).length, 2);
  });

  it('Agent isolation: agent A stores, agent B searches same text, gets 0', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    await mem.store('agent-a', 'isolated term');
    const results = await mem.search('agent-b', 'isolated term');

    assert.equal(results.length, 0);
  });

  it('Reinforce then decay - reinforced memories survive', async () => {
    const mem = createMemory({
      storage: { type: 'memory' },
      graph: { archiveThreshold: 0.75, deleteThreshold: 0.01 },
    });

    const weak = await mem.store('agent-a', 'weak memory', { importance: 0.4 });
    const strong = await mem.store('agent-a', 'reinforced memory', { importance: 0.5 });
    await mem.reinforce(strong.id, 0.5);

    const report = await mem.decay();
    assert.ok(report.archived.some(m => m.id === weak.id));
    assert.ok(!report.archived.some(m => m.id === strong.id));
  });

  it('Store -> archive via decay -> verify archived count', async () => {
    const mem = createMemory({
      storage: { type: 'memory' },
      graph: { archiveThreshold: 0.95, deleteThreshold: 0.01 },
    });

    await mem.store('agent-a', 'archive me', { importance: 0.5 });
    await mem.decay();

    const health = await mem.health();
    assert.equal(health.archivedCount, 1);
    assert.equal(health.total, 0);
  });
});

describe('Integration - edge cases', () => {
  it('Store 100 memories for one agent - no crash, health accurate', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    for (let i = 0; i < 100; i += 1) {
      await mem.store('bulk-agent', `bulk memory ${i}`);
    }

    const report = await mem.health();
    assert.equal(report.total, 100);
    assert.equal(report.byAgent['bulk-agent'], 100);
  });

  it('Store memory with very long text (10KB) - rejects over max length', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const longText = `prefix-${'x'.repeat(10240)}-suffix`;
    await assert.rejects(() => mem.store('agent-a', longText), /text exceeds max length/);
  });

  it('Store with all categories (fact, preference, decision, finding) - each category works', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    await mem.store('agent-a', 'fact text', { category: 'fact' });
    await mem.store('agent-a', 'preference text', { category: 'preference' });
    await mem.store('agent-a', 'decision text', { category: 'decision' });
    await mem.store('agent-a', 'finding text', { category: 'finding' });

    const report = await mem.health();
    assert.equal(report.byCategory.fact, 1);
    assert.equal(report.byCategory.preference, 1);
    assert.equal(report.byCategory.decision, 1);
    assert.equal(report.byCategory.finding, 1);
  });

  it('Store empty string - rejected', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    await assert.rejects(() => mem.store('agent-a', ''), /text must be a non-empty string/);
  });

  it('Search with special characters - no crash', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    await mem.store('agent-a', 'special []{}()^$.*+?|\\ chars');
    const results = await mem.search('agent-a', '[]{}()^$.*+?|\\');

    assert.equal(results.length, 1);
  });

  it('Evolve same text twice - idempotent', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const first = await mem.store('agent-a', 'stable text');
    mem.detectConflicts = async () => ({
      conflicts: [],
      updates: [{ index: 0, reason: 'No-op update', memoryId: first.id }],
      novel: false,
    });

    const result = await mem.evolve('agent-a', 'stable text');
    const report = await mem.health();

    assert.equal(result.evolved, true);
    assert.equal(report.total, 1);
  });

  it('Decay on brand new graph (0 memories) - returns zero report', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const report = await mem.decay();
    assert.equal(report.total, 0);
    assert.equal(report.archived.length, 0);
    assert.equal(report.deleted.length, 0);
  });

  it('Health report distribution sums correctly', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    await mem.store('agent-a', 'one');
    await mem.store('agent-a', 'two');
    await mem.store('agent-a', 'three');

    const report = await mem.health();
    const sum = Object.values(report.distribution).reduce((a, b) => a + b, 0);
    assert.equal(sum, report.total);
  });

  it('Path between unconnected memories returns not found', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const a = await mem.store('agent-a', 'path a');
    const b = await mem.store('agent-a', 'path b');

    const result = await mem.path(a.id, b.id);
    assert.ok(result);
    assert.equal(result.found, false);
    assert.equal(result.hops, -1);
  });

  it('Concurrent stores (Promise.all) - no data corruption', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });

    const writes = Array.from({ length: 20 }, (_, i) => mem.store('agent-a', `concurrent ${i}`));
    await Promise.all(writes);

    const report = await mem.health();
    assert.equal(report.total, 20);
    assert.equal(report.byAgent['agent-a'], 20);
  });
});
