import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { supabaseStorage } from '../src/supabase-storage.mjs';
import { createMockSupabase } from './mock-supabase.mjs';

/**
 * Tests that MemoryGraph uses incremental storage ops when available,
 * avoiding full save() cycles.
 */

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

function deterministicLinkedEmbeddings() {
  return {
    name: 'linked', model: 'linked',
    async embed(...texts) {
      const input = texts.length === 1 && Array.isArray(texts[0]) ? texts[0] : texts;
      return input.map((_, idx) => idx === 0 ? [1, 0, 0] : [0.99, 0.01, 0]);
    },
  };
}

describe('MemoryGraph incremental storage', () => {
  let mock, graph, saveCalls;

  beforeEach(() => {
    mock = createMockSupabase();
    const storage = supabaseStorage({
      url: 'https://test.supabase.co',
      key: 'test-key',
      fetch: mock.fetch,
    });

    // Wrap save() to count calls
    const origSave = storage.save.bind(storage);
    saveCalls = 0;
    storage.save = async (mems) => { saveCalls++; return origSave(mems); };

    graph = new MemoryGraph({
      storage,
      embeddings: fakeEmbeddings(),
      config: { linkThreshold: 0.5, maxLinksPerMemory: 5 },
    });
  });

  it('store() uses upsert instead of full save when incremental', async () => {
    await graph.store('a1', 'First fact');
    await graph.store('a1', 'Second fact');
    // With incremental, save() should NOT be called (upsert handles it)
    expect(saveCalls).toBe(0);
  });

  it('reinforce() uses upsert instead of full save when incremental', async () => {
    await graph.store('a1', 'Reinforced fact');
    saveCalls = 0; // Reset after store
    await graph.reinforce(graph.memories[0].id, 0.1);
    expect(saveCalls).toBe(0);
  });

  it('search() tries storage.search() first when available', async () => {
    await graph.store('a1', 'Delegated search test');

    // Spy: track if storage.search was called
    let searchCalled = false;
    const origSearch = graph.storage.search;
    graph.storage.search = async (...args) => {
      searchCalled = true;
      return origSearch(...args);
    };

    await graph.search('a1', 'Delegated');
    expect(searchCalled).toBe(true);
  });

  it('search() reconciles storage.search() results back to in-memory metadata', async () => {
    const stored = await graph.store('a1', 'Reconciled search memory');
    graph._byId(stored.id).claim = { subject: 'user', predicate: 'topic', value: 'reconciled', scope: 'global' };
    graph._byId(stored.id).links = [{ id: 'other', similarity: 0.9, type: 'similar' }];

    graph.storage.search = async () => ([{
      id: stored.id,
      agent: 'a1',
      memory: 'Reconciled search memory',
      score: 0.88,
    }]);

    const results = await graph.search('a1', 'Reconciled');
    expect(results).toHaveLength(1);
    expect(results[0].claim?.predicate).toBe('topic');
    expect(results[0].links).toEqual([{ id: 'other', similarity: 0.9, type: 'similar' }]);
    expect(typeof results[0].confidence).toBe('number');
  });

  it('data is still accessible after incremental store', async () => {
    await graph.store('a1', 'Accessible fact');

    // New graph instance, same mock backend
    const graph2 = new MemoryGraph({
      storage: supabaseStorage({
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: mock.fetch,
      }),
      embeddings: fakeEmbeddings(),
    });
    const results = await graph2.search('a1', 'Accessible');
    expect(results.length).toBe(1);
  });

  it('storeMany() persists link rows for incremental storage so links survive reload', async () => {
    graph.embeddings = deterministicLinkedEmbeddings();

    const result = await graph.storeMany('a1', [
      'shared alpha signal repeated repeated repeated',
      'shared alpha signal repeated repeated repeated extra',
    ]);

    expect(result.stored).toBe(2);
    expect(mock.getTable('memory_links').length).toBeGreaterThan(0);

    const graph2 = new MemoryGraph({
      storage: supabaseStorage({
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: mock.fetch,
      }),
      embeddings: fakeEmbeddings(),
    });
    await graph2.init();

    const reloaded = graph2.memories.filter(m => m.agent === 'a1');
    expect(reloaded).toHaveLength(2);
    expect(reloaded.every(m => (m.links || []).length > 0)).toBe(true);
  });

  it('storeMany() rolls back when incremental link persistence fails', async () => {
    const storage = supabaseStorage({
      url: 'https://test.supabase.co',
      key: 'test-key',
      fetch: mock.fetch,
    });
    storage.upsertLinks = async () => { throw new Error('link write failed'); };

    const failingGraph = new MemoryGraph({
      storage,
      embeddings: deterministicLinkedEmbeddings(),
      config: { linkThreshold: 0.5, maxLinksPerMemory: 5 },
    });

    await expect(failingGraph.storeMany('a1', [
      'shared alpha signal repeated repeated repeated',
      'shared alpha signal repeated repeated repeated extra',
    ])).rejects.toThrow('link write failed');

    expect(failingGraph.memories.length).toBe(0);
    expect(failingGraph._idIndex.size).toBe(0);
    expect(mock.getTable('memories')).toHaveLength(0);
    expect(mock.getTable('memory_links')).toHaveLength(0);
  });
});

describe('MemoryGraph retrieval helpers', () => {
  it('search recent-only mode returns most recent candidate memories in descending created_at order', async () => {
    const graph = new MemoryGraph({
      storage: supabaseStorage({
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: createMockSupabase().fetch,
      }),
      embeddings: fakeEmbeddings(),
    });

    const older = await graph.store('a', 'older memory');
    const newer = await graph.store('a', 'newer memory');

    graph._byId(older.id).created_at = '2026-01-01T00:00:00.000Z';
    graph._byId(newer.id).created_at = '2026-01-02T00:00:00.000Z';

    const results = await graph.search('a', '', { limit: 10 });
    expect(results.map(r => r.id)).toEqual([newer.id, older.id]);
    expect(results.every(r => r.score === 0)).toBe(true);
    expect(results.every(r => r.embedding === undefined)).toBe(true);
  });
});
