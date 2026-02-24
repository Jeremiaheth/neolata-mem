import { describe, it, expect } from 'vitest';
import { MemoryGraph, tokenize } from '../src/graph.mjs';

// ── Helpers ─────────────────────────────────────────────
function noopEmbed() {
  return { embed: async (...texts) => texts.map(() => null) };
}

function fakeEmbed(dim = 4) {
  let counter = 0;
  return {
    embed: async (...texts) => texts.map(() => {
      counter++;
      const v = Array(dim).fill(0);
      v[counter % dim] = 1;
      return v;
    }),
  };
}

function memStorage() {
  let data = [];
  return {
    load: async () => data,
    save: async (d) => { data = d; },
    loadArchive: async () => [],
    saveArchive: async () => {},
    genId: () => crypto.randomUUID(),
  };
}

// ── tokenize ────────────────────────────────────────────
describe('tokenize', () => {
  it('lowercases and splits', () => {
    expect(tokenize('Hello World')).toEqual(['hello', 'world']);
  });

  it('removes stop words', () => {
    const tokens = tokenize('The quick brown fox is a fast animal');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('deduplicates', () => {
    expect(tokenize('cat cat cat dog')).toEqual(['cat', 'dog']);
  });

  it('strips non-alphanumeric', () => {
    expect(tokenize("it's a test! #123")).toContain('test');
    expect(tokenize("it's a test! #123")).toContain('123');
  });

  it('drops single-char tokens', () => {
    expect(tokenize('a b c dd ee')).toEqual(['dd', 'ee']);
  });
});

// ── Keyword search with normalization ───────────────────
describe('keyword search (normalized)', () => {
  it('matches partial token overlap and scores by fraction', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await graph.store('a', 'database security vulnerability');
    await graph.store('a', 'security best practices');
    await graph.store('a', 'cooking recipes');

    const results = await graph.search('a', 'security vulnerability');
    expect(results.length).toBe(2);
    // First result matches both tokens (score=1.0), second matches one (score=0.5)
    expect(results[0].score).toBe(1.0);
    expect(results[0].memory).toBe('database security vulnerability');
    expect(results[1].score).toBe(0.5);
  });

  it('falls back to substring match when all query words are stop words', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await graph.store('a', 'it is what it is');

    const results = await graph.search('a', 'it is');
    expect(results.length).toBe(1);
  });

  it('case-insensitive matching', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await graph.store('a', 'PostgreSQL Performance Tuning');

    const results = await graph.search('a', 'postgresql performance');
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(1.0);
  });
});

// ── _byId index ────────────────────────────────────────
describe('id index', () => {
  it('provides O(1) lookups after store', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    const { id } = await graph.store('a', 'test memory');
    expect(graph._byId(id)).toBeDefined();
    expect(graph._byId(id).memory).toBe('test memory');
  });

  it('returns undefined for missing ids', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await graph.init();
    expect(graph._byId('nonexistent')).toBeUndefined();
  });
});

// ── storeMany ──────────────────────────────────────────
describe('storeMany', () => {
  it('stores multiple memories in one call', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    const result = await graph.storeMany('agent', [
      { text: 'fact one', category: 'fact' },
      { text: 'fact two', category: 'decision' },
      { text: 'fact three' },
    ]);

    expect(result.total).toBe(3);
    expect(result.stored).toBe(3);
    expect(result.results).toHaveLength(3);

    const all = await graph.search('agent', 'fact');
    expect(all.length).toBe(3);
  });

  it('accepts plain strings as items', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    const result = await graph.storeMany('agent', ['hello world', 'goodbye world']);
    expect(result.stored).toBe(2);
  });

  it('validates inputs', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await expect(graph.storeMany('', [{ text: 'x' }])).rejects.toThrow('agent');
    await expect(graph.storeMany('a', [])).rejects.toThrow('non-empty array');
    await expect(graph.storeMany('a', [{ text: '' }])).rejects.toThrow('non-empty string');
  });

  it('rejects batch exceeding maxBatchSize', async () => {
    const graph = new MemoryGraph({
      storage: memStorage(), embeddings: noopEmbed(),
      config: { maxBatchSize: 3 },
    });
    await expect(graph.storeMany('a', [
      { text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' },
    ])).rejects.toThrow('exceeds max batch size');
  });

  it('allows batch within maxBatchSize', async () => {
    const graph = new MemoryGraph({
      storage: memStorage(), embeddings: noopEmbed(),
      config: { maxBatchSize: 3 },
    });
    const result = await graph.storeMany('a', [{ text: 'one' }, { text: 'two' }]);
    expect(result.stored).toBe(2);
  });

  it('respects memory cap', async () => {
    const graph = new MemoryGraph({
      storage: memStorage(), embeddings: noopEmbed(),
      config: { maxMemories: 2 },
    });
    await expect(graph.storeMany('a', [
      { text: 'one' }, { text: 'two' }, { text: 'three' },
    ])).rejects.toThrow('memory limit');
  });

  it('rolls back on embedding failure mid-batch', async () => {
    let callCount = 0;
    const failingEmbed = {
      embed: async (...texts) => {
        callCount++;
        if (callCount > 1) throw new Error('API quota exceeded');
        return texts.map(() => null);
      },
    };
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: failingEmbed });
    // 128 items = 2 batches of 64. Second batch will fail.
    const items = Array.from({ length: 128 }, (_, i) => ({ text: `memory ${i}` }));
    await expect(graph.storeMany('a', items, { embeddingBatchSize: 64 })).rejects.toThrow('API quota');
    // Rollback: no memories should remain
    expect(graph.memories.length).toBe(0);
    expect(graph._idIndex.size).toBe(0);
  });

  it('rolls back on save failure after successful embedding', async () => {
    const failStorage = {
      ...memStorage(),
      save: async () => { throw new Error('disk full'); },
    };
    const graph = new MemoryGraph({ storage: failStorage, embeddings: noopEmbed() });
    await expect(graph.storeMany('a', [{ text: 'one' }])).rejects.toThrow('disk full');
    expect(graph.memories.length).toBe(0);
  });

  it('emits store events for each item', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    const events = [];
    graph.on('store', e => events.push(e));
    await graph.storeMany('a', ['x', 'y', 'z']);
    expect(events).toHaveLength(3);
  });
});

// ── S7: Token index reindex on evolve update ───────────
describe('token index consistency on memory update', () => {
  it('finds memory by new text after in-place update', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    const { id } = await graph.store('a', 'python programming language');

    // Simulate evolve() in-place update: change memory text
    const mem = graph._byId(id);
    graph._deindexMemory(mem);
    mem.memory = 'rust programming language';
    graph._indexMemory(mem);

    // Should find by new text
    const results = await graph.search('a', 'rust');
    expect(results.length).toBe(1);
    expect(results[0].memory).toBe('rust programming language');

    // Should NOT find by old text
    const old = await graph.search('a', 'python');
    expect(old.length).toBe(0);
  });

  it('BUG: evolve update without reindex causes stale results', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    const { id } = await graph.store('a', 'python programming language');

    // Simulate what evolve() currently does: update text WITHOUT reindexing
    const mem = graph._byId(id);
    mem.memory = 'rust programming language';
    // No deindex/reindex!

    // This SHOULD find rust but won't until S7 is fixed in evolve()
    const results = await graph.search('a', 'rust');
    // Before fix: 0 results (stale index). After fix in evolve(): this test becomes moot.
    expect(results.length).toBe(0); // documents the bug
  });
});

// ── searchMany ─────────────────────────────────────────
describe('searchMany', () => {
  it('searches multiple queries in one call', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await graph.store('a', 'database security');
    await graph.store('a', 'cooking recipes');
    await graph.store('a', 'database performance');

    const results = await graph.searchMany('a', ['database', 'cooking']);
    expect(results).toHaveLength(2);
    expect(results[0].query).toBe('database');
    expect(results[0].results.length).toBe(2);
    expect(results[1].query).toBe('cooking');
    expect(results[1].results.length).toBe(1);
  });

  it('validates inputs', async () => {
    const graph = new MemoryGraph({ storage: memStorage(), embeddings: noopEmbed() });
    await expect(graph.searchMany('a', [])).rejects.toThrow('non-empty array');
  });

  it('rejects queries exceeding maxQueryBatchSize', async () => {
    const graph = new MemoryGraph({
      storage: memStorage(), embeddings: noopEmbed(),
      config: { maxQueryBatchSize: 2 },
    });
    await graph.store('a', 'test');
    await expect(graph.searchMany('a', ['q1', 'q2', 'q3'])).rejects.toThrow('exceeds max query batch size');
  });
});
