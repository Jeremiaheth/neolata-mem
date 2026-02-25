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

function mockLLM(response) {
  return { name: 'mock-llm', async chat() { return typeof response === 'string' ? response : JSON.stringify(response); } };
}

describe('Episodes', () => {
  describe('createEpisode', () => {
    it('should create an episode from memory IDs', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Started debugging auth');
      const r2 = await graph.store('a', 'Found the JWT bug');
      const ep = await graph.createEpisode('Auth debugging session', [r1.id, r2.id], { tags: ['debug'] });
      expect(ep.id).toMatch(/^ep_/);
      expect(ep.memberCount).toBe(2);
      expect(ep.timeRange.start).toBeTruthy();
      expect(ep.timeRange.end).toBeTruthy();
    });

    it('should reject empty name', async () => {
      const graph = createTestGraph();
      await expect(graph.createEpisode('', ['mem_1'])).rejects.toThrow('Episode name');
    });

    it('should reject non-existent memory IDs', async () => {
      const graph = createTestGraph();
      await expect(graph.createEpisode('test', ['fake_id'])).rejects.toThrow('Memory not found');
    });

    it('should track multiple agents', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('agent-1', 'Memory from agent 1');
      const r2 = await graph.store('agent-2', 'Memory from agent 2');
      const ep = await graph.createEpisode('Multi-agent episode', [r1.id, r2.id]);
      const full = await graph.getEpisode(ep.id);
      expect(full.agents).toContain('agent-1');
      expect(full.agents).toContain('agent-2');
    });
  });

  describe('getEpisode', () => {
    it('should return episode with resolved memories', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const ep = await graph.createEpisode('Test', [r1.id, r2.id]);
      const full = await graph.getEpisode(ep.id);
      expect(full.name).toBe('Test');
      expect(full.memories.length).toBe(2);
      expect(full.memories[0].memory).toBeTruthy();
    });

    it('should return null for non-existent episode', async () => {
      const graph = createTestGraph();
      const result = await graph.getEpisode('ep_fake');
      expect(result).toBeNull();
    });
  });

  describe('deleteEpisode', () => {
    it('should delete episode but keep memories', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const ep = await graph.createEpisode('Test', [r1.id]);
      const result = await graph.deleteEpisode(ep.id);
      expect(result.deleted).toBe(true);
      expect(await graph.getEpisode(ep.id)).toBeNull();
      const mem = graph.memories.find(m => m.id === r1.id);
      expect(mem).toBeTruthy();
    });

    it('should return deleted:false for non-existent episode', async () => {
      const graph = createTestGraph();
      const result = await graph.deleteEpisode('ep_fake');
      expect(result.deleted).toBe(false);
    });
  });

  describe('captureEpisode', () => {
    it('should capture memories within a time window', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Event one', { eventTime: '2026-01-15T10:00:00Z' });
      await graph.store('a', 'Event two', { eventTime: '2026-01-15T14:00:00Z' });
      await graph.store('a', 'Event outside', { eventTime: '2026-02-01T10:00:00Z' });
      const ep = await graph.captureEpisode('a', 'Jan 15 session', {
        start: '2026-01-15T00:00:00Z', end: '2026-01-15T23:59:59Z',
      });
      expect(ep.memberCount).toBe(2);
    });

    it('should reject if not enough memories', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Only one', { eventTime: '2026-01-15T10:00:00Z' });
      await expect(graph.captureEpisode('a', 'test', {
        start: '2026-01-15T00:00:00Z', end: '2026-01-15T23:59:59Z',
      })).rejects.toThrow('minimum');
    });

    it('should reject invalid time range', async () => {
      const graph = createTestGraph();
      await expect(graph.captureEpisode('a', 'test', {
        start: '2026-02-01', end: '2026-01-01',
      })).rejects.toThrow('start must be before end');
    });
  });

  describe('addToEpisode', () => {
    it('should add memories to an episode', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const r3 = await graph.store('a', 'Memory three');
      const ep = await graph.createEpisode('Test', [r1.id]);
      const result = await graph.addToEpisode(ep.id, [r2.id, r3.id]);
      expect(result.added).toBe(2);
      expect(result.memberCount).toBe(3);
    });

    it('should not duplicate existing members', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const ep = await graph.createEpisode('Test', [r1.id]);
      const result = await graph.addToEpisode(ep.id, [r1.id]);
      expect(result.added).toBe(0);
      expect(result.memberCount).toBe(1);
    });

    it('should reject non-existent episode', async () => {
      const graph = createTestGraph();
      await expect(graph.addToEpisode('ep_fake', ['mem_1'])).rejects.toThrow('Episode not found');
    });
  });

  describe('removeFromEpisode', () => {
    it('should remove memories from an episode', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const ep = await graph.createEpisode('Test', [r1.id, r2.id]);
      const result = await graph.removeFromEpisode(ep.id, [r2.id]);
      expect(result.removed).toBe(1);
      expect(result.memberCount).toBe(1);
    });

    it('should update agents list after removal', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('agent-1', 'Memory one');
      const r2 = await graph.store('agent-2', 'Memory two');
      const ep = await graph.createEpisode('Test', [r1.id, r2.id]);
      await graph.removeFromEpisode(ep.id, [r2.id]);
      const full = await graph.getEpisode(ep.id);
      expect(full.agents).toContain('agent-1');
      expect(full.agents).not.toContain('agent-2');
    });

    it('should update time range after removal', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Early', { eventTime: '2026-01-01T00:00:00Z' });
      const r2 = await graph.store('a', 'Late', { eventTime: '2026-06-01T00:00:00Z' });
      const ep = await graph.createEpisode('Test', [r1.id, r2.id]);
      expect(ep.timeRange.end).toContain('2026-06');
      await graph.removeFromEpisode(ep.id, [r2.id]);
      const full = await graph.getEpisode(ep.id);
      expect(full.timeRange.end).toContain('2026-01');
    });
  });

  describe('listEpisodes', () => {
    it('should list episodes with filters', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one', { eventTime: '2026-01-15T00:00:00Z' });
      const r2 = await graph.store('b', 'Memory two', { eventTime: '2026-02-15T00:00:00Z' });
      await graph.createEpisode('Ep 1', [r1.id], { tags: ['debug'] });
      await graph.createEpisode('Ep 2', [r2.id], { tags: ['feature'] });

      const all = await graph.listEpisodes();
      expect(all.length).toBe(2);

      const byAgent = await graph.listEpisodes({ agent: 'a' });
      expect(byAgent.length).toBe(1);
      expect(byAgent[0].name).toBe('Ep 1');

      const byTag = await graph.listEpisodes({ tag: 'debug' });
      expect(byTag.length).toBe(1);
    });
  });

  describe('searchEpisode', () => {
    it('should search within episode members', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'JWT token validation bug');
      const r2 = await graph.store('a', 'CSS styling issue');
      const r3 = await graph.store('a', 'Database connection pool');
      const ep = await graph.createEpisode('Debug session', [r1.id, r2.id]);
      const results = await graph.searchEpisode(ep.id, 'JWT authentication');
      expect(results.length).toBeLessThanOrEqual(2);
      expect(results.every(r => r.id !== r3.id)).toBe(true);
    });

    it('should reject non-existent episode', async () => {
      const graph = createTestGraph();
      await expect(graph.searchEpisode('ep_fake', 'test')).rejects.toThrow('Episode not found');
    });
  });

  describe('summarizeEpisode', () => {
    it('should generate and persist a summary', async () => {
      const graph = createTestGraph({ llm: mockLLM('This episode covers debugging the auth system.') });
      const r1 = await graph.store('a', 'Found JWT bug');
      const r2 = await graph.store('a', 'Fixed JWT validation');
      const ep = await graph.createEpisode('Auth debug', [r1.id, r2.id]);
      const result = await graph.summarizeEpisode(ep.id);
      expect(result.summary).toContain('auth');
      const full = await graph.getEpisode(ep.id);
      expect(full.summary).toBe(result.summary);
    });

    it('should require LLM provider', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory');
      const ep = await graph.createEpisode('Test', [r1.id]);
      await expect(graph.summarizeEpisode(ep.id)).rejects.toThrow('LLM provider');
    });
  });

  describe('episode events', () => {
    it('should emit episode:create on createEpisode', async () => {
      const graph = createTestGraph();
      const events = [];
      graph.on('episode:create', e => events.push(e));
      const r1 = await graph.store('a', 'Memory');
      await graph.createEpisode('Test', [r1.id]);
      expect(events.length).toBe(1);
      expect(events[0].name).toBe('Test');
    });

    it('should emit episode:update on add/remove', async () => {
      const graph = createTestGraph();
      const events = [];
      graph.on('episode:update', e => events.push(e));
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const ep = await graph.createEpisode('Test', [r1.id]);
      await graph.addToEpisode(ep.id, [r2.id]);
      await graph.removeFromEpisode(ep.id, [r2.id]);
      expect(events.length).toBe(2);
      expect(events[0].action).toBe('add');
      expect(events[1].action).toBe('remove');
    });

    it('should emit episode:delete on deleteEpisode', async () => {
      const graph = createTestGraph();
      const events = [];
      graph.on('episode:delete', e => events.push(e));
      const r1 = await graph.store('a', 'Memory');
      const ep = await graph.createEpisode('Test', [r1.id]);
      await graph.deleteEpisode(ep.id);
      expect(events.length).toBe(1);
      expect(events[0].id).toBe(ep.id);
    });
  });
});
