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
});
