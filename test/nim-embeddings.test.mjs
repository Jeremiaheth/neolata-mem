import { describe, it, expect, vi } from 'vitest';
import { openaiEmbeddings, noopEmbeddings } from '../src/embeddings.mjs';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';

describe('NIM input_type support', () => {
  it('sends input_type=passage on embed() when nimInputType=true', async () => {
    const bodies = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) };
    });

    const emb = openaiEmbeddings({
      apiKey: 'test', model: 'baai/bge-m3',
      baseUrl: 'https://nim.test/v1', nimInputType: true,
    });

    await emb.embed('hello');
    expect(bodies[0].input_type).toBe('passage');
  });

  it('sends input_type=query on embedQuery() when nimInputType=true', async () => {
    const bodies = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) };
    });

    const emb = openaiEmbeddings({
      apiKey: 'test', model: 'baai/bge-m3',
      baseUrl: 'https://nim.test/v1', nimInputType: true,
    });

    await emb.embedQuery('hello');
    expect(bodies[0].input_type).toBe('query');
  });

  it('does NOT send input_type when nimInputType=false', async () => {
    const bodies = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) };
    });

    const emb = openaiEmbeddings({
      apiKey: 'test', model: 'text-embedding-3-small',
    });

    await emb.embed('hello');
    await emb.embedQuery('hello');
    expect(bodies[0].input_type).toBeUndefined();
    expect(bodies[1].input_type).toBeUndefined();
  });

  it('MemoryGraph.search() uses embedQuery for retrieval', async () => {
    let queryCallCount = 0;
    const fakeEmb = {
      name: 'fake-nim', model: 'fake',
      async embed(texts) {
        const input = Array.isArray(texts) ? texts : [texts];
        return input.map(() => [0.1, 0.2, 0.3]);
      },
      async embedQuery(text) {
        queryCallCount++;
        return [[0.1, 0.2, 0.3]];
      },
    };

    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmb,
    });

    await graph.store('a1', 'Test memory');
    await graph.search('a1', 'Test');
    expect(queryCallCount).toBe(1);
  });
});
