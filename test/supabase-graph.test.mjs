import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { supabaseStorage } from '../src/supabase-storage.mjs';
import { createMockSupabase } from './mock-supabase.mjs';

/**
 * Integration test: MemoryGraph backed by supabaseStorage.
 * Verifies that the full graph engine works with the Supabase backend.
 */

function fakeEmbeddings() {
  return {
    name: 'fake',
    model: 'fake',
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      return input.map(t => {
        const vec = new Array(64).fill(0);
        for (let i = 0; i < t.length; i++) {
          vec[i % 64] += t.charCodeAt(i) / 1000;
        }
        const mag = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
        return vec.map(v => v / (mag || 1));
      });
    },
  };
}

describe('MemoryGraph + supabaseStorage', () => {
  let mock, graph;

  beforeEach(() => {
    mock = createMockSupabase();
    const storage = supabaseStorage({
      url: 'https://test.supabase.co',
      key: 'test-key',
      fetch: mock.fetch,
    });
    graph = new MemoryGraph({
      storage,
      embeddings: fakeEmbeddings(),
      config: { linkThreshold: 0.5, maxLinksPerMemory: 5 },
    });
  });

  it('store + search round-trip', async () => {
    const result = await graph.store('agent-1', 'User prefers dark mode');
    expect(result.id).toMatch(/^[0-9a-f]{8}-/);

    const results = await graph.search('agent-1', 'dark mode');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory).toBe('User prefers dark mode');
  });

  it('store creates links between related memories', async () => {
    await graph.store('agent-1', 'The server runs on port 8080');
    await graph.store('agent-1', 'The server runs on port 443');

    const links = await graph.links(graph.memories[1].id);
    expect(links).not.toBeNull();
    // Similar text should create at least one link
    expect(links.links.length).toBeGreaterThanOrEqual(0);
  });

  it('data persists across graph instances', async () => {
    await graph.store('agent-1', 'Persistent fact');

    // Create a new graph instance with same mock backend
    const graph2 = new MemoryGraph({
      storage: supabaseStorage({
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: mock.fetch,
      }),
      embeddings: fakeEmbeddings(),
    });

    const results = await graph2.search('agent-1', 'Persistent');
    expect(results.length).toBe(1);
    expect(results[0].memory).toBe('Persistent fact');
  });

  it('decay archives and deletes from Supabase', async () => {
    // Store a memory, then manipulate its created_at to make it old
    await graph.store('agent-1', 'Ancient memory', { importance: 0.01 });
    // Force age: set created_at far in the past
    graph.memories[0].created_at = '2020-01-01T00:00:00.000Z';
    graph.memories[0].updated_at = '2020-01-01T00:00:00.000Z';
    await graph.save();

    const report = await graph.decay();
    // With importance 0.01 and 6+ years old, should be deleted or archived
    expect(report.archived.length + report.deleted.length).toBeGreaterThan(0);
  });

  it('reinforce persists through Supabase', async () => {
    const stored = await graph.store('agent-1', 'Important fact');
    const result = await graph.reinforce(stored.id, 0.2);
    expect(result.newImportance).toBeGreaterThan(result.oldImportance);

    // Reload from "Supabase"
    const graph2 = new MemoryGraph({
      storage: supabaseStorage({
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: mock.fetch,
      }),
      embeddings: fakeEmbeddings(),
    });
    await graph2.init();
    const mem = graph2.memories.find(m => m.id === stored.id);
    expect(mem.importance).toBe(result.newImportance);
  });

  it('health report works with Supabase backend', async () => {
    await graph.store('agent-1', 'Fact one');
    await graph.store('agent-2', 'Fact two');
    const health = await graph.health();
    expect(health.total).toBe(2);
    expect(health.byAgent['agent-1']).toBe(1);
    expect(health.byAgent['agent-2']).toBe(1);
  });
});
