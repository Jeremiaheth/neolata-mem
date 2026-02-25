import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/index.mjs';

describe('Event Emitter', () => {
  it('emits "store" event when a memory is stored', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });
    const events = [];
    mem.on('store', (data) => events.push(data));

    await mem.store('agent1', 'Test memory');

    expect(events.length).toBe(1);
    expect(events[0].agent).toBe('agent1');
    expect(events[0].content).toBe('Test memory');
    expect(events[0].id, 'should have an id').toBeTruthy();
    expect(events[0].category, 'should have a category').toBeTruthy();
  });

  it('emits "search" event when a search is performed', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });
    await mem.store('a', 'Redis runs on port 6379');

    const events = [];
    mem.on('search', (data) => events.push(data));

    await mem.search('a', 'Redis port');

    expect(events.length).toBe(1);
    expect(events[0].agent).toBe('a');
    expect(events[0].query).toBe('Redis port');
    expect(typeof events[0].resultCount === 'number').toBeTruthy();
  });

  it('emits "decay" event when decay runs', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });
    await mem.store('a', 'Some old memory');

    const events = [];
    mem.on('decay', (data) => events.push(data));

    await mem.decay({ dryRun: true });

    expect(events.length).toBe(1);
    expect(typeof events[0].total === 'number').toBeTruthy();
    expect(typeof events[0].dryRun === 'boolean').toBeTruthy();
  });

  it('supports removeListener / off', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });
    const events = [];
    const handler = (data) => events.push(data);
    mem.on('store', handler);
    mem.off('store', handler);

    await mem.store('a', 'Should not emit');
    expect(events.length).toBe(0);
  });

  it('emits "link" event when links are created', async () => {
    const mem = createMemory({ storage: { type: 'memory' } });
    await mem.store('a', 'Redis is a key-value store');

    const events = [];
    mem.on('link', (data) => events.push(data));

    await mem.store('a', 'Redis runs on port 6379');

    // Should have link events if memories are related
    // (keyword search may or may not find similarity, so just check the event structure)
    for (const ev of events) {
      expect(ev.sourceId, 'should have sourceId').toBeTruthy();
      expect(ev.targetId, 'should have targetId').toBeTruthy();
      expect(typeof ev.similarity === 'number').toBeTruthy();
    }
  });

  it('should emit link events with type field', async () => {
    // Use MemoryGraph directly to pass custom embeddings
    const { MemoryGraph } = await import('../src/graph.mjs');
    const { memoryStorage } = await import('../src/storage.mjs');
    const fakeEmbed = {
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
    const graph = new MemoryGraph({ storage: memoryStorage(), embeddings: fakeEmbed, config: { linkThreshold: 0.1 } });
    const events = [];
    graph.on('link', (ev) => events.push(ev));
    await graph.store('a', 'memory about testing');
    await graph.store('a', 'another memory about testing code');
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.type).toBe('similar');
    }
  });
});
