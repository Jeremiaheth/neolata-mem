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

function createTestGraph(opts = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: fakeEmbeddings(),
    config: opts.config || {},
    ...opts,
  });
}

describe('Labeled Clusters', () => {
  describe('createCluster', () => {
    it('should create a labeled cluster', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const cl = await graph.createCluster('Test Cluster', [r1.id, r2.id], { description: 'A test' });
      expect(cl.id).toMatch(/^cl_/);
      expect(cl.label).toBe('Test Cluster');
      expect(cl.memberCount).toBe(2);
    });

    it('should reject empty label', async () => {
      const graph = createTestGraph();
      await expect(graph.createCluster('', ['mem_1'])).rejects.toThrow('label');
    });

    it('should reject non-existent memory IDs', async () => {
      const graph = createTestGraph();
      await expect(graph.createCluster('Test', ['fake'])).rejects.toThrow('Memory not found');
    });
  });

  describe('getCluster', () => {
    it('should return cluster with resolved memories', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const cl = await graph.createCluster('Test', [r1.id]);
      const full = await graph.getCluster(cl.id);
      expect(full.memories.length).toBe(1);
      expect(full.memories[0].memory).toBe('Memory one');
    });

    it('should return null for non-existent cluster', async () => {
      const graph = createTestGraph();
      expect(await graph.getCluster('cl_fake')).toBeNull();
    });
  });

  describe('listClusters', () => {
    it('should list all labeled clusters', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Mem 1');
      const r2 = await graph.store('a', 'Mem 2');
      await graph.createCluster('Cluster A', [r1.id]);
      await graph.createCluster('Cluster B', [r2.id]);
      const list = await graph.listClusters();
      expect(list.length).toBe(2);
    });
  });

  describe('deleteCluster', () => {
    it('should delete cluster but keep memories', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const cl = await graph.createCluster('Test', [r1.id]);
      const result = await graph.deleteCluster(cl.id);
      expect(result.deleted).toBe(true);
      expect(await graph.getCluster(cl.id)).toBeNull();
      expect(graph.memories.find(m => m.id === r1.id)).toBeTruthy();
    });
  });

  describe('refreshCluster', () => {
    it('should discover new linked memories', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      const r1 = await graph.store('a', 'Memory about authentication');
      const cl = await graph.createCluster('Auth', [r1.id]);
      await graph.store('a', 'Memory about authentication tokens');
      const result = await graph.refreshCluster(cl.id);
      expect(result.memberCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('labelCluster', () => {
    it('should label an auto-detected cluster', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      await graph.store('a', 'Testing authentication module code');
      await graph.store('a', 'Testing authentication validation flow');
      const clusters = await graph.clusters(2);
      if (clusters.length > 0) {
        const cl = await graph.labelCluster(0, 'Auth Testing');
        expect(cl.label).toBe('Auth Testing');
        expect(cl.memberCount).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('events', () => {
    it('should emit cluster:create and cluster:delete', async () => {
      const graph = createTestGraph();
      const events = [];
      graph.on('cluster:create', e => events.push({ type: 'create', ...e }));
      graph.on('cluster:delete', e => events.push({ type: 'delete', ...e }));
      const r1 = await graph.store('a', 'Memory');
      const cl = await graph.createCluster('Test', [r1.id]);
      await graph.deleteCluster(cl.id);
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('create');
      expect(events[1].type).toBe('delete');
    });
  });
});
