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
  let callCount = 0;
  const responses = Array.isArray(response) ? response : [response];
  return {
    name: 'mock-llm',
    async chat() {
      const r = responses[Math.min(callCount++, responses.length - 1)];
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  };
}

describe('v0.7.0 Integration', () => {
  it('full lifecycle: episodes ??? compression ??? labeled clusters', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      llm: mockLLM([
        'The team debugged and fixed a JWT authentication bug on March 1st.',
        '{"label": "Auth System", "description": "Authentication and JWT handling"}',
      ]),
      config: { linkThreshold: 0.1 },
    });

    // 1. Store memories
    const r1 = await graph.store('dev', 'Started investigating auth failures', { eventTime: '2026-03-01T09:00:00Z', category: 'event' });
    const r2 = await graph.store('dev', 'Found JWT token expiry bug in auth module', { eventTime: '2026-03-01T10:30:00Z' });
    const r3 = await graph.store('dev', 'Fixed JWT validation logic', { eventTime: '2026-03-01T14:00:00Z', category: 'fact' });
    const r4 = await graph.store('dev', 'Deployed JWT fix to production', { eventTime: '2026-03-01T16:00:00Z', category: 'event' });
    const r5 = await graph.store('dev', 'Updated README documentation', { eventTime: '2026-03-05T10:00:00Z' });

    // 2. Capture episode
    const ep = await graph.captureEpisode('dev', 'JWT Bug Fix Session', {
      start: '2026-03-01T00:00:00Z', end: '2026-03-01T23:59:59Z',
      tags: ['bug', 'auth', 'jwt'],
    });
    expect(ep.memberCount).toBe(4);

    // 3. Search within episode
    const searchResults = await graph.searchEpisode(ep.id, 'JWT token');
    expect(searchResults.length).toBeGreaterThan(0);

    // 4. Summarize episode
    const { summary } = await graph.summarizeEpisode(ep.id);
    expect(summary).toBeTruthy();

    // 5. Compress episode
    const compressed = await graph.compressEpisode(ep.id, { method: 'llm' });
    expect(compressed.sourceCount).toBe(4);
    const digest = graph.memories.find(m => m.id === compressed.id);
    expect(digest.category).toBe('digest');
    expect(digest.compressed.episodeId).toBe(ep.id);

    // 6. Create labeled cluster
    const cl = await graph.createCluster('Authentication', [r1.id, r2.id, r3.id, r4.id], {
      description: 'All auth-related memories',
    });
    expect(cl.memberCount).toBe(4);

    // 7. List and get cluster
    const clusterList = await graph.listClusters();
    expect(clusterList.length).toBe(1);
    const full = await graph.getCluster(cl.id);
    expect(full.memories.length).toBe(4);

    // 8. Health check
    const health = await graph.health();
    expect(health.total).toBeGreaterThan(0);
    expect(health.byCategory.digest).toBe(1);

    // 9. Backward compat
    const timeline = await graph.timeline('dev', 365);
    expect(timeline.total).toBeGreaterThan(0);
    const context = await graph.context('dev', 'JWT authentication');
    expect(context.count).toBeGreaterThan(0);
  });
});
