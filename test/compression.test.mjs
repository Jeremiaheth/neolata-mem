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

function createTestGraph(opts = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: fakeEmbeddings(),
    config: opts.config || {},
    ...opts,
  });
}

describe('Compression', () => {
  describe('compress', () => {
    it('should compress memories with extractive method', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Server runs on port 3000');
      const r2 = await graph.store('a', 'Server uses Express framework');
      const result = await graph.compress([r1.id, r2.id]);
      expect(result.sourceCount).toBe(2);
      expect(result.summary).toBeTruthy();
      const digest = graph.memories.find(m => m.id === result.id);
      expect(digest.category).toBe('digest');
      expect(digest.compressed).toBeDefined();
      expect(digest.compressed.method).toBe('extractive');
    });

    it('should compress memories with LLM method', async () => {
      const graph = createTestGraph({ llm: mockLLM('Server runs Express on port 3000.') });
      const r1 = await graph.store('a', 'Server runs on port 3000');
      const r2 = await graph.store('a', 'Server uses Express framework');
      const result = await graph.compress([r1.id, r2.id], { method: 'llm' });
      expect(result.summary).toContain('Express');
    });

    it('should create digest_of and digested_into links', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Fact one about testing');
      const r2 = await graph.store('a', 'Fact two about validation');
      const result = await graph.compress([r1.id, r2.id]);
      const digest = graph.memories.find(m => m.id === result.id);
      expect(digest.links.some(l => l.type === 'digest_of' && l.id === r1.id)).toBe(true);
      const source = graph.memories.find(m => m.id === r1.id);
      expect(source.links.some(l => l.type === 'digested_into' && l.id === result.id)).toBe(true);
    });

    it('should archive originals when requested', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const result = await graph.compress([r1.id, r2.id], { archiveOriginals: true });
      expect(result.archived).toBe(2);
      expect(graph.memories.find(m => m.id === r1.id)).toBeUndefined();
      expect(graph.memories.find(m => m.id === r2.id)).toBeUndefined();
      expect(graph.memories.find(m => m.id === result.id)).toBeTruthy();
    });

    it('should reject fewer than 2 memories', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Only one');
      await expect(graph.compress([r1.id])).rejects.toThrow('at least 2');
    });

    it('should inherit highest importance', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Low importance', { importance: 0.3 });
      const r2 = await graph.store('a', 'High importance', { importance: 0.9 });
      const result = await graph.compress([r1.id, r2.id]);
      const digest = graph.memories.find(m => m.id === result.id);
      expect(digest.importance).toBe(0.9);
    });
  });
});

describe('compressEpisode', () => {
  it('should compress an episode', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Episode memory one about coding');
    const r2 = await graph.store('a', 'Episode memory two about testing');
    const ep = await graph.createEpisode('Test Episode', [r1.id, r2.id]);
    const result = await graph.compressEpisode(ep.id);
    expect(result.sourceCount).toBe(2);
    const digest = graph.memories.find(m => m.id === result.id);
    expect(digest.compressed.episodeId).toBe(ep.id);
  });

  it('should reject non-existent episode', async () => {
    const graph = createTestGraph();
    await expect(graph.compressEpisode('ep_fake')).rejects.toThrow('Episode not found');
  });
});

describe('compressCluster', () => {
  it('should compress a cluster by index', async () => {
    const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
    await graph.store('a', 'Testing the authentication module code');
    await graph.store('a', 'Testing the authentication validation flow');
    await graph.store('a', 'Testing the authentication token handling');
    const clusters = await graph.clusters(2);
    if (clusters.length > 0) {
      const result = await graph.compressCluster(0, { minSize: 2 });
      expect(result.sourceCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('should reject out of range index', async () => {
    const graph = createTestGraph();
    await expect(graph.compressCluster(99)).rejects.toThrow('out of range');
  });
});

describe('autoCompress', () => {
  it('should auto-compress clusters', async () => {
    const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
    await graph.store('a', 'Authentication module uses JWT tokens');
    await graph.store('a', 'Authentication validation checks JWT expiry');
    await graph.store('a', 'Authentication flow generates JWT tokens');
    const result = await graph.autoCompress({ minClusterSize: 2 });
    expect(typeof result.compressed).toBe('number');
    expect(Array.isArray(result.digests)).toBe(true);
  });

  it('should skip clusters containing digests', async () => {
    const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
    const r1 = await graph.store('a', 'Auth fact one about tokens');
    const r2 = await graph.store('a', 'Auth fact two about tokens');
    await graph.compress([r1.id, r2.id]);
    const result = await graph.autoCompress({ minClusterSize: 2 });
    expect(result.compressed).toBeLessThanOrEqual(1);
  });
});
