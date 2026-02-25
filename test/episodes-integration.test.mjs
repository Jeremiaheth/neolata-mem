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

describe('Episodes Integration', () => {
  it('full lifecycle: store ??? capture ??? search ??? summarize ??? modify ??? delete', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      llm: mockLLM('Summary of the debugging session: found and fixed JWT bug.'),
      config: { linkThreshold: 0.1 },
    });

    const r1 = await graph.store('dev', 'Started investigating auth failures', { eventTime: '2026-03-01T09:00:00Z' });
    const r2 = await graph.store('dev', 'Found JWT token expiry bug', { eventTime: '2026-03-01T10:30:00Z' });
    const r3 = await graph.store('dev', 'Deployed JWT fix to staging', { eventTime: '2026-03-01T14:00:00Z' });
    const r4 = await graph.store('dev', 'Unrelated: updated README', { eventTime: '2026-03-05T10:00:00Z' });

    const ep = await graph.captureEpisode('dev', 'JWT Bug Investigation', {
      start: '2026-03-01T00:00:00Z', end: '2026-03-01T23:59:59Z',
      tags: ['bug', 'auth'],
    });
    expect(ep.memberCount).toBe(3);

    const results = await graph.searchEpisode(ep.id, 'JWT token');
    expect(results.length).toBeGreaterThan(0);

    const { summary } = await graph.summarizeEpisode(ep.id);
    expect(summary).toContain('JWT');

    const list = await graph.listEpisodes({ agent: 'dev', tag: 'auth' });
    expect(list.length).toBe(1);
    expect(list[0].summary).toBeTruthy();

    await graph.addToEpisode(ep.id, [r4.id]);
    let full = await graph.getEpisode(ep.id);
    expect(full.memoryIds.length).toBe(4);

    await graph.removeFromEpisode(ep.id, [r4.id]);
    full = await graph.getEpisode(ep.id);
    expect(full.memoryIds.length).toBe(3);

    const deleted = await graph.deleteEpisode(ep.id);
    expect(deleted.deleted).toBe(true);
    expect(graph.memories.length).toBe(4);
  });
});
