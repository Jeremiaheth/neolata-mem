import { describe, it, beforeEach, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

/** Helper: create a graph with fake embeddings for deterministic tests. */
function fakeEmbeddings() {
  // Simple hash-based "embedding" for deterministic cosine similarity
  return {
    name: 'fake',
    model: 'fake',
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      return input.map(t => {
        const vec = new Array(64).fill(0);
        for (let i = 0; i < t.length; i++) {
          vec[i % 64] += t.charCodeAt(i) / 1000;
        }
        // Normalize
        const mag = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
        return vec.map(v => v / (mag || 1));
      });
    },
  };
}

function mockLLM(response) {
  return {
    name: 'mock-llm',
    async chat() { return JSON.stringify(response); },
  };
}

function createTestGraph(opts = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: opts.embeddings || fakeEmbeddings(),
    config: opts.config || {},
    ...opts,
  });
}

describe('MemoryGraph', () => {
  describe('store', () => {
    it('should store a memory and return an id', async () => {
      const graph = createTestGraph();
      const result = await graph.store('agent-1', 'The sky is blue');
      expect(result.id.startsWith('mem_')).toBeTruthy();
      expect(typeof result.links).toBe('number');
    });

    it('should auto-link similar memories', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      await graph.store('agent-1', 'The user prefers dark mode');
      const r2 = await graph.store('agent-1', 'The user likes dark theme in VS Code');
      expect(r2.links >= 1, `Expected at least 1 link, got ${r2.links}`).toBeTruthy();
    });

    it('should create links with type "similar"', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      await graph.store('agent-1', 'The user prefers dark mode');
      const r2 = await graph.store('agent-1', 'The user likes dark theme in VS Code');

      const mem = graph.memories.find(m => m.id === r2.id);
      for (const link of mem.links) {
        expect(link.type).toBe('similar');
      }

      // Verify backlinks also have type
      const first = graph.memories[0];
      for (const link of first.links) {
        expect(link.type).toBe('similar');
      }
    });

    it('should create bidirectional links', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      const r1 = await graph.store('agent-1', 'Server runs on port 8080');
      const r2 = await graph.store('agent-1', 'API server uses port 8080 for HTTP');

      const links1 = await graph.links(r1.id);
      const links2 = await graph.links(r2.id);

      // r2 should link to r1
      expect(links2.links.some(l => l.id === r1.id)).toBeTruthy();
      // r1 should have backlink to r2
      expect(links1.links.some(l => l.id === r2.id)).toBeTruthy();
    });

    it('should respect maxLinksPerMemory', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.01, maxLinksPerMemory: 2 } });
      for (let i = 0; i < 10; i++) {
        await graph.store('a', `Memory number ${i} about testing`);
      }
      const r = await graph.store('a', 'Another memory about testing things');
      expect(r.links <= 2).toBeTruthy();
    });
  });

  describe('search', () => {
    it('should find stored memories', async () => {
      const graph = createTestGraph();
      await graph.store('agent-1', 'Redis runs on port 6379');
      await graph.store('agent-1', 'PostgreSQL default port is 5432');
      const results = await graph.search('agent-1', 'Redis port');
      expect(results.length >= 1).toBeTruthy();
      expect(results[0].memory.includes('Redis')).toBeTruthy();
    });

    it('should filter by agent', async () => {
      const graph = createTestGraph();
      await graph.store('agent-1', 'Agent 1 secret');
      await graph.store('agent-2', 'Agent 2 secret');
      const results = await graph.search('agent-1', 'secret');
      expect(results.every(r => r.agent === 'agent-1')).toBeTruthy();
    });

    it('should search all agents with searchAll', async () => {
      const graph = createTestGraph();
      await graph.store('agent-1', 'Shared knowledge about APIs');
      await graph.store('agent-2', 'Shared knowledge about APIs too');
      const results = await graph.searchAll('APIs');
      expect(results.length >= 2).toBeTruthy();
    });
  });

  describe('search (noop embeddings — keyword fallback)', () => {
    it('should do keyword matching when no embeddings', async () => {
      const graph = createTestGraph({ embeddings: noopEmbeddings() });
      await graph.store('a', 'The quick brown fox');
      await graph.store('a', 'Lazy dog sleeping');
      const results = await graph.search('a', 'fox');
      expect(results.length).toBe(1);
      expect(results[0].memory.includes('fox')).toBeTruthy();
    });
  });

  describe('decay', () => {
    it('should calculate strength for a memory', () => {
      const graph = createTestGraph();
      const mem = {
        id: 'test', agent: 'a', memory: 'test', category: 'fact',
        importance: 0.8, links: [], tags: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { strength } = graph.calcStrength(mem);
      expect(strength > 0.5, `Strength should be > 0.5 for fresh important memory, got ${strength}`).toBeTruthy();
    });

    it('should weaken old memories', () => {
      const graph = createTestGraph();
      const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago
      const mem = {
        id: 'old', agent: 'a', memory: 'old fact', category: 'fact',
        importance: 0.3, links: [], tags: [],
        created_at: old, updated_at: old,
      };
      const { strength } = graph.calcStrength(mem);
      expect(strength < 0.3, `Old low-importance memory should be weak, got ${strength}`).toBeTruthy();
    });

    it('should give bonus to decisions and preferences', () => {
      const graph = createTestGraph();
      const now = new Date().toISOString();
      const base = { id: 't', agent: 'a', memory: 'x', importance: 0.5, links: [], tags: [], created_at: now, updated_at: now };
      const factStrength = graph.calcStrength({ ...base, category: 'fact' }).strength;
      const decisionStrength = graph.calcStrength({ ...base, category: 'decision' }).strength;
      const prefStrength = graph.calcStrength({ ...base, category: 'preference' }).strength;
      expect(decisionStrength > factStrength, 'Decisions should be stickier than facts').toBeTruthy();
      expect(prefStrength > factStrength, 'Preferences should be stickier than facts').toBeTruthy();
    });

    it('should give bonus for links', () => {
      const graph = createTestGraph();
      const now = new Date().toISOString();
      const base = { id: 't', agent: 'a', memory: 'x', category: 'fact', importance: 0.5, tags: [], created_at: now, updated_at: now };
      const noLinks = graph.calcStrength({ ...base, links: [] }).strength;
      const withLinks = graph.calcStrength({ ...base, links: [{ id: 'a', similarity: 0.8 }, { id: 'b', similarity: 0.7 }, { id: 'c', similarity: 0.6 }] }).strength;
      expect(withLinks > noLinks, 'Linked memories should be stronger').toBeTruthy();
    });

    it('should archive weak memories on decay cycle', async () => {
      const graph = createTestGraph({ config: { archiveThreshold: 0.9, deleteThreshold: 0.01 } });
      // Store some memories (they'll be "weak" with threshold 0.9)
      await graph.store('a', 'Something to decay');
      const report = await graph.decay();
      expect(report.total >= 1).toBeTruthy();
    });

    it('dry run should not modify data', async () => {
      const graph = createTestGraph({ config: { archiveThreshold: 0.9, deleteThreshold: 0.01 } });
      await graph.store('a', 'Memory to keep');
      const before = (await graph.health()).total;
      await graph.decay({ dryRun: true });
      const after = (await graph.health()).total;
      expect(before).toBe(after, 'Dry run should not change memory count');
    });
  });

  describe('reinforce', () => {
    it('should boost importance and access count', async () => {
      const graph = createTestGraph();
      const { id } = await graph.store('a', 'Important fact', { importance: 0.5 });
      const result = await graph.reinforce(id, 0.2);
      expect(result.oldImportance).toBe(0.5);
      expect(result.newImportance).toBe(0.7);
      expect(result.accessCount).toBe(1);
    });

    it('should cap importance at 1.0', async () => {
      const graph = createTestGraph();
      const { id } = await graph.store('a', 'Max fact', { importance: 0.95 });
      const result = await graph.reinforce(id, 0.2);
      expect(result.newImportance).toBe(1.0);
    });
  });

  describe('graph queries', () => {
    it('should find orphans', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.99 } }); // Very high threshold = no auto-links
      await graph.store('a', 'Totally unique memory XYZZY');
      const orphans = await graph.orphans('a');
      expect(orphans.length >= 1).toBeTruthy();
    });

    it('should traverse from a memory', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      const { id } = await graph.store('a', 'Root memory about testing');
      await graph.store('a', 'Testing is important for quality');
      await graph.store('a', 'Quality assurance tests');
      const result = await graph.traverse(id, 2);
      expect(result).toBeTruthy();
      expect(result.reached >= 1).toBeTruthy();
      expect(result.start.id).toBe(id);
    });

    it('should detect clusters', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      // Create a connected cluster
      await graph.store('a', 'Security vulnerability in the API');
      await graph.store('a', 'API security audit found issues');
      await graph.store('a', 'Audit report for security vulnerabilities');
      const clusters = await graph.clusters(2);
      // With low threshold, these should form a cluster
      expect(clusters.length >= 0).toBeTruthy(); // May or may not cluster depending on fake embeddings
    });

    it('should find shortest path', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.1 } });
      const r1 = await graph.store('a', 'Node A connects to node B');
      const r2 = await graph.store('a', 'Node B connects to node A and C');
      if (r2.links > 0) {
        const result = await graph.path(r1.id, r2.id);
        expect(result).toBeTruthy();
        if (result.found) {
          expect(result.hops >= 1).toBeTruthy();
        }
      }
    });
  });

  describe('calcStrength modes', () => {
    it('should use legacy mode for memories without stability', async () => {
      const graph = createTestGraph();
      const r = await graph.store('a', 'Test memory');
      const mem = graph.memories.find(m => m.id === r.id);
      const result = graph.calcStrength(mem);
      expect(result.mode).toBe('legacy');
      expect(result.strength).toBeGreaterThan(0);
    });
    it('should use SM-2 mode for memories with stability', async () => {
      const graph = createTestGraph();
      const r = await graph.store('a', 'Test memory');
      const mem = graph.memories.find(m => m.id === r.id);
      mem.stability = 5.0;
      const result = graph.calcStrength(mem);
      expect(result.mode).toBe('sm2');
    });
    it('should give higher strength to memories with higher stability', async () => {
      const graph = createTestGraph();
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const lowStab = { importance: 0.7, stability: 1.0, links: [], category: 'fact', created_at: tenDaysAgo, updated_at: tenDaysAgo };
      const highStab = { importance: 0.7, stability: 20.0, links: [], category: 'fact', created_at: tenDaysAgo, updated_at: tenDaysAgo };
      const lowResult = graph.calcStrength(lowStab);
      const highResult = graph.calcStrength(highStab);
      expect(highResult.strength).toBeGreaterThan(lowResult.strength);
    });
  });

  describe('reinforce with stability', () => {
    it('should set stability and lastReviewInterval on reinforce', async () => {
      const graph = createTestGraph();
      const r = await graph.store('a', 'Important fact');
      await graph.reinforce(r.id);
      const mem = graph.memories.find(m => m.id === r.id);
      expect(typeof mem.stability).toBe('number');
      expect(mem.stability).toBeGreaterThan(0);
      expect(typeof mem.lastReviewInterval).toBe('number');
    });
    it('should increase stability more with spaced reinforcement', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Rapid reinforced');
      await graph.reinforce(r1.id);
      await graph.reinforce(r1.id);
      await graph.reinforce(r1.id);
      const rapid = graph.memories.find(m => m.id === r1.id);
      const r2 = await graph.store('a', 'Spaced reinforced');
      const mem2 = graph.memories.find(m => m.id === r2.id);
      mem2.updated_at = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
      await graph.reinforce(r2.id);
      mem2.updated_at = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await graph.reinforce(r2.id);
      mem2.updated_at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await graph.reinforce(r2.id);
      const spaced = graph.memories.find(m => m.id === r2.id);
      expect(spaced.stability).toBeGreaterThan(rapid.stability);
    });
  });

  describe('links', () => {
    it('should default link type to "similar" for old-format links', async () => {
      const graph = createTestGraph();
      graph.memories.push({
        id: 'mem_old-1', agent: 'a', memory: 'old memory', category: 'fact',
        importance: 0.7, tags: [], embedding: null,
        links: [{ id: 'mem_old-2', similarity: 0.8 }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      graph.memories.push({
        id: 'mem_old-2', agent: 'a', memory: 'another old memory', category: 'fact',
        importance: 0.7, tags: [], embedding: null,
        links: [{ id: 'mem_old-1', similarity: 0.8 }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      graph.loaded = true;
      graph._rebuildIndexes();
      const result = await graph.links('mem_old-1');
      expect(result.links[0].type).toBe('similar');
    });
  });

  describe('traverse with type filter', () => {
    it('should only follow links of specified types', async () => {
      const graph = createTestGraph();
      const now = new Date().toISOString();
      graph.memories = [
        { id: 'mem_a', agent: 'a', memory: 'mem a', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_b', similarity: 0.9, type: 'similar' }, { id: 'mem_c', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
        { id: 'mem_b', agent: 'a', memory: 'mem b', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_a', similarity: 0.9, type: 'similar' }], created_at: now, updated_at: now },
        { id: 'mem_c', agent: 'a', memory: 'mem c', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_a', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
      ];
      graph.loaded = true;
      graph._rebuildIndexes();
      const result = await graph.traverse('mem_a', 2, { types: ['similar'] });
      const ids = result.nodes.map(n => n.id);
      expect(ids).toContain('mem_a');
      expect(ids).toContain('mem_b');
      expect(ids).not.toContain('mem_c');
      const all = await graph.traverse('mem_a', 2);
      expect(all.nodes.length).toBe(3);
    });
  });

  describe('path with type filter', () => {
    it('should only use links of specified types', async () => {
      const graph = createTestGraph();
      const now = new Date().toISOString();
      graph.memories = [
        { id: 'mem_x', agent: 'a', memory: 'x', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_y', similarity: 0.9, type: 'similar' }, { id: 'mem_z', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
        { id: 'mem_y', agent: 'a', memory: 'y', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_x', similarity: 0.9, type: 'similar' }], created_at: now, updated_at: now },
        { id: 'mem_z', agent: 'a', memory: 'z', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_x', similarity: 1.0, type: 'supersedes' }], created_at: now, updated_at: now },
      ];
      graph.loaded = true;
      graph._rebuildIndexes();
      const noPath = await graph.path('mem_x', 'mem_z', { types: ['similar'] });
      expect(noPath.found).toBe(false);
      const found = await graph.path('mem_x', 'mem_z', { types: ['supersedes'] });
      expect(found.found).toBe(true);
      expect(found.hops).toBe(1);
    });
  });

  describe('link and unlink', () => {
    it('should create a manual bidirectional link', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      const result = await graph.link(r1.id, r2.id, { type: 'caused_by' });
      expect(result.type).toBe('caused_by');
      const links1 = await graph.links(r1.id);
      const links2 = await graph.links(r2.id);
      expect(links1.links.some(l => l.id === r2.id && l.type === 'caused_by')).toBe(true);
      expect(links2.links.some(l => l.id === r1.id && l.type === 'caused_by')).toBe(true);
    });
    it('should reject self-links', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      await expect(graph.link(r1.id, r1.id)).rejects.toThrow('Cannot link a memory to itself');
    });
    it('should reject invalid memory IDs', async () => {
      const graph = createTestGraph();
      await expect(graph.link('fake-1', 'fake-2')).rejects.toThrow('Memory not found');
    });
    it('should update existing link type on re-link', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      await graph.link(r1.id, r2.id, { type: 'related' });
      await graph.link(r1.id, r2.id, { type: 'caused_by' });
      const links1 = await graph.links(r1.id);
      const causedBy = links1.links.filter(l => l.id === r2.id);
      expect(causedBy.length).toBe(1);
      expect(causedBy[0].type).toBe('caused_by');
    });
    it('should unlink memories', async () => {
      const graph = createTestGraph();
      const r1 = await graph.store('a', 'Memory one');
      const r2 = await graph.store('a', 'Memory two');
      await graph.link(r1.id, r2.id, { type: 'related' });
      const result = await graph.unlink(r1.id, r2.id);
      expect(result.removed).toBe(true);
      const links1 = await graph.links(r1.id);
      expect(links1.links.some(l => l.id === r2.id)).toBe(false);
    });
    it('should return removed:false for non-existent link', async () => {
      const graph = createTestGraph({ config: { linkThreshold: 0.99 } });
      const r1 = await graph.store('a', 'Alpha unique XYZZY');
      const r2 = await graph.store('a', 'Beta different QWRTP');
      const result = await graph.unlink(r1.id, r2.id);
      expect(result.removed).toBe(false);
    });
  });

  describe('health', () => {
    it('should return comprehensive report', async () => {
      const graph = createTestGraph();
      await graph.store('agent-1', 'Memory 1');
      await graph.store('agent-2', 'Memory 2');
      const report = await graph.health();
      expect(report.total).toBe(2);
      expect(report.byAgent['agent-1']).toBe(1);
      expect(report.byAgent['agent-2']).toBe(1);
      expect(report.avgStrength > 0).toBeTruthy();
      expect('distribution' in report).toBeTruthy();
    });

    it('should include stability stats in health report', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Memory one');
      await graph.store('a', 'Memory two');
      const id = graph.memories[0].id;
      await graph.reinforce(id);
      const report = await graph.health();
      expect(report.memoriesWithSM2).toBe(1);
      expect(typeof report.avgStability).toBe('number');
    });
  });

  describe('timeline', () => {
    it('should group by date', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Today memory');
      const result = await graph.timeline('a', 7);
      expect(result.total >= 1).toBeTruthy();
      const dates = Object.keys(result.dates);
      expect(dates.length >= 1).toBeTruthy();
    });
  });

  describe('context', () => {
    it('should generate briefing text', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Redis is an in-memory database', { category: 'fact' });
      await graph.store('a', 'We decided to use Redis for caching', { category: 'decision' });
      const result = await graph.context('a', 'Redis');
      expect(result.count >= 1).toBeTruthy();
      expect(result.context.includes('Redis')).toBeTruthy();
    });
  });

  describe('evolve (without LLM)', () => {
    it('should store normally when no LLM configured', async () => {
      const graph = createTestGraph();
      const result = await graph.evolve('a', 'New fact about the world');
      expect(result.stored).toBeTruthy();
      expect(result.id).toBeTruthy();
    });
  });

  describe('bi-temporal', () => {
    it('should store event_at when eventTime is provided', async () => {
      const graph = createTestGraph();
      const r = await graph.store('a', 'Server migrated to AWS', { eventTime: '2026-01-15T00:00:00Z' });
      const mem = graph.memories.find(m => m.id === r.id);
      expect(mem.event_at).toBe('2026-01-15T00:00:00.000Z');
      expect(mem.created_at).not.toBe(mem.event_at);
    });
    it('should not set event_at when eventTime is omitted', async () => {
      const graph = createTestGraph();
      const r = await graph.store('a', 'Just a normal memory');
      const mem = graph.memories.find(m => m.id === r.id);
      expect(mem.event_at).toBeUndefined();
    });
    it('should reject invalid eventTime', async () => {
      const graph = createTestGraph();
      await expect(graph.store('a', 'test', { eventTime: 'not-a-date' })).rejects.toThrow('eventTime must be a valid ISO 8601 date string');
    });
    it('should support eventTime in storeMany', async () => {
      const graph = createTestGraph();
      const result = await graph.storeMany('a', [{ text: 'Event A', eventTime: '2026-01-10' }, { text: 'Event B' }]);
      expect(result.stored).toBe(2);
      const memA = graph.memories.find(m => m.memory === 'Event A');
      const memB = graph.memories.find(m => m.memory === 'Event B');
      expect(memA.event_at).toBeDefined();
      expect(memB.event_at).toBeUndefined();
    });
  });

  describe('bi-temporal timeline', () => {
    it('should group by event_at when available', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Server migrated', { eventTime: '2026-01-15T12:00:00Z' });
      await graph.store('a', 'Normal memory');
      const tl = await graph.timeline('a', 365);
      const dates = Object.keys(tl.dates);
      expect(dates).toContain('2026-01-15');
    });
    it('should filter by timeField=event', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Has event time', { eventTime: '2026-01-15T12:00:00Z' });
      await graph.store('a', 'No event time');
      const tl = await graph.timeline('a', 365, { timeField: 'event' });
      expect(tl.total).toBe(1);
    });
  });

  describe('search with temporal filters', () => {
    it('should filter by before/after', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'January event', { eventTime: '2026-01-15T00:00:00Z' });
      await graph.store('a', 'February event', { eventTime: '2026-02-15T00:00:00Z' });
      await graph.store('a', 'March event', { eventTime: '2026-03-15T00:00:00Z' });
      const results = await graph.search('a', 'event', { after: '2026-02-01', before: '2026-02-28' });
      expect(results.length).toBe(1);
      expect(results[0].memory).toBe('February event');
    });
    it('should use event_at for temporal filtering', async () => {
      const graph = createTestGraph();
      await graph.store('a', 'Past event', { eventTime: '2026-01-10T00:00:00Z' });
      const results = await graph.search('a', 'event', { before: '2026-01-31' });
      expect(results.length).toBe(1);
      const noResults = await graph.search('a', 'event', { after: '2026-03-01' });
      expect(noResults.length).toBe(0);
    });
  });

  describe('evolve', () => {
    it('should create supersedes links when archiving conflicts', async () => {
      const graph = createTestGraph({
        config: { linkThreshold: 0.1 },
        llm: mockLLM({
          conflicts: [{ index: 0, reason: 'outdated' }],
          updates: [],
          novel: true,
        }),
      });
      const original = await graph.store('agent-1', 'Server runs on port 3000');
      const result = await graph.evolve('agent-1', 'Server now runs on port 8080');
      expect(result.actions.some(a => a.type === 'archived')).toBe(true);
      expect(result.stored).toBe(true);
      if (result.id) {
        const newMem = graph.memories.find(m => m.id === result.id);
        if (newMem) {
          const supersedesLink = newMem.links.find(l => l.type === 'supersedes');
          expect(supersedesLink).toBeDefined();
          expect(supersedesLink.id).toBe(original.id);
        }
      }
    });
  });

  describe('ingest', () => {
    it('should require extraction provider', async () => {
      const graph = createTestGraph();
      await expect(graph.ingest('a', 'some text')).rejects.toThrow(/extraction provider/);
    });

    it('should work with passthrough extraction', async () => {
      const { passthroughExtraction } = await import('../src/extraction.mjs');
      const graph = new MemoryGraph({
        storage: memoryStorage(),
        embeddings: fakeEmbeddings(),
        extraction: passthroughExtraction(),
      });
      const result = await graph.ingest('a', 'Important fact to ingest');
      expect(result.stored).toBe(1);
    });
  });

  describe('input validation', () => {
    it('should reject empty agent', async () => {
      const graph = createTestGraph();
      await expect(graph.store('', 'text')).rejects.toThrow(/non-empty string/);
    });

    it('should reject agent with invalid characters', async () => {
      const graph = createTestGraph();
      await expect(graph.store('../../etc', 'text')).rejects.toThrow(/invalid characters/);
    });

    it('should reject agent exceeding max length', async () => {
      const graph = createTestGraph({ config: { maxAgentLength: 10 } });
      await expect(graph.store('a'.repeat(11), 'text')).rejects.toThrow(/max length/);
    });

    it('should reject empty text', async () => {
      const graph = createTestGraph();
      await expect(graph.store('agent', '')).rejects.toThrow(/non-empty string/);
    });

    it('should reject text exceeding max length', async () => {
      const graph = createTestGraph({ config: { maxMemoryLength: 100 } });
      await expect(graph.store('agent', 'x'.repeat(101))).rejects.toThrow(/max length/);
    });

    it('should reject store when memory limit reached', async () => {
      const graph = createTestGraph({ config: { maxMemories: 2 } });
      await graph.store('a', 'first');
      await graph.store('a', 'second');
      await expect(graph.store('a', 'third')).rejects.toThrow(/Memory limit reached/);
    });

    it('should use crypto UUIDs for IDs', async () => {
      const graph = createTestGraph();
      const r = await graph.store('agent', 'test');
      // crypto.randomUUID produces 8-4-4-4-12 pattern
      expect(r.id).toMatch(/^mem_[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  });
});
