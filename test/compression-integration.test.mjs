import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';

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

function mockLLM(response) {
  return { name: 'mock-llm', async chat() { return typeof response === 'string' ? response : JSON.stringify(response); } };
}

describe('Compression Integration', () => {
  it('episode ??? compress ??? search finds digest', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      llm: mockLLM('The server uses Express on port 3000 with JWT auth.'),
      config: { linkThreshold: 0.1 },
    });

    const r1 = await graph.store('dev', 'Server runs on port 3000', { eventTime: '2026-03-01T09:00:00Z' });
    const r2 = await graph.store('dev', 'Server uses Express framework', { eventTime: '2026-03-01T10:00:00Z' });
    const r3 = await graph.store('dev', 'JWT authentication configured', { eventTime: '2026-03-01T11:00:00Z' });

    const ep = await graph.createEpisode('Server setup', [r1.id, r2.id, r3.id]);

    const compressed = await graph.compressEpisode(ep.id, { method: 'llm', archiveOriginals: true });
    expect(compressed.sourceCount).toBe(3);

    expect(graph.memories.find(m => m.id === r1.id)).toBeUndefined();

    const results = await graph.search('dev', 'server configuration');
    expect(results.some(r => r.id === compressed.id)).toBe(true);

    const digest = graph.memories.find(m => m.id === compressed.id);
    expect(digest.category).toBe('digest');
    expect(digest.compressed.episodeId).toBe(ep.id);
    expect(digest.compressed.sourceCount).toBe(3);

    const health = await graph.health();
    expect(health.byCategory.digest).toBe(1);
  });
});
