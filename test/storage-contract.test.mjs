import { describe, it, expect } from 'vitest';
import { jsonStorage, memoryStorage } from '../src/storage.mjs';
import { supabaseStorage } from '../src/supabase-storage.mjs';
import { createMockSupabase } from './mock-supabase.mjs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Storage Contract Tests
 *
 * Any storage backend must implement:
 *   - load() → Memory[]
 *   - save(memories) → void
 *   - loadArchive() → Memory[]
 *   - saveArchive(archived) → void
 *   - genId() → string (unique)
 *
 * These tests verify the contract. New backends (Supabase, Redis, etc.)
 * should be added to the backends array below.
 */

const sampleMemories = [
  {
    id: 'mem_test-1',
    agent: 'agent-1',
    memory: 'User prefers dark mode',
    category: 'preference',
    importance: 0.8,
    tags: ['ui', 'theme'],
    embedding: [0.1, 0.2, 0.3],
    links: [{ id: 'mem_test-2', similarity: 0.7 }],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'mem_test-2',
    agent: 'agent-1',
    memory: 'Project uses React',
    category: 'fact',
    importance: 0.6,
    tags: ['tech'],
    embedding: [0.4, 0.5, 0.6],
    links: [{ id: 'mem_test-1', similarity: 0.7 }],
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  },
];

const sampleArchive = [
  {
    id: 'mem_archived-1',
    agent: 'agent-1',
    memory: 'Old preference',
    category: 'preference',
    importance: 0.3,
    tags: [],
    links: [],
    created_at: '2025-01-01T00:00:00.000Z',
    archived_at: '2026-01-01T00:00:00.000Z',
  },
];

/** Factory functions for each backend. Returns { storage, cleanup }. */
const backends = {
  memoryStorage: async () => ({
    storage: memoryStorage(),
    cleanup: async () => {},
  }),
  jsonStorage: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-test-'));
    return {
      storage: jsonStorage({ dir }),
      cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
    };
  },
  supabaseStorage: async () => {
    const mock = createMockSupabase();
    return {
      storage: supabaseStorage({
        url: 'https://test.supabase.co',
        key: 'test-key',
        fetch: mock.fetch,
      }),
      cleanup: async () => { mock.reset(); },
    };
  },
};

for (const [name, factory] of Object.entries(backends)) {
  describe(`Storage Contract: ${name}`, () => {
    let storage, cleanup;

    // Fresh backend per test
    async function fresh() {
      if (cleanup) await cleanup();
      const ctx = await factory();
      storage = ctx.storage;
      cleanup = ctx.cleanup;
      return storage;
    }

    // ── load/save ──

    it('load() returns empty array on fresh backend', async () => {
      const s = await fresh();
      const result = await s.load();
      expect(result).toEqual([]);
    });

    it('save() then load() round-trips memories', async () => {
      const s = await fresh();
      await s.save(sampleMemories);
      const loaded = await s.load();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe('mem_test-1');
      expect(loaded[0].memory).toBe('User prefers dark mode');
      expect(loaded[0].embedding).toEqual([0.1, 0.2, 0.3]);
      // supabase adds type from loadLinks; memory/json preserve raw format
      expect(loaded[0].links[0].id).toBe('mem_test-2');
      expect(loaded[0].links[0].similarity).toBe(0.7);
      expect(loaded[1].id).toBe('mem_test-2');
    });

    it('save() overwrites previous data', async () => {
      const s = await fresh();
      await s.save(sampleMemories);
      await s.save([sampleMemories[0]]);
      const loaded = await s.load();
      expect(loaded).toHaveLength(1);
    });

    it('save() then load() preserves all fields', async () => {
      const s = await fresh();
      await s.save(sampleMemories);
      const loaded = await s.load();
      // Deep equality on all fields
      expect(loaded[0].agent).toBe('agent-1');
      expect(loaded[0].category).toBe('preference');
      expect(loaded[0].importance).toBe(0.8);
      expect(loaded[0].tags).toEqual(['ui', 'theme']);
      expect(loaded[0].created_at).toBe('2026-01-01T00:00:00.000Z');
      expect(loaded[0].updated_at).toBe('2026-01-01T00:00:00.000Z');
    });

    // ── archive ──

    it('loadArchive() returns empty array on fresh backend', async () => {
      const s = await fresh();
      const result = await s.loadArchive();
      expect(result).toEqual([]);
    });

    it('saveArchive() then loadArchive() round-trips', async () => {
      const s = await fresh();
      await s.saveArchive(sampleArchive);
      const loaded = await s.loadArchive();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('mem_archived-1');
      expect(loaded[0].archived_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('archive is independent of main store', async () => {
      const s = await fresh();
      await s.save(sampleMemories);
      await s.saveArchive(sampleArchive);
      const memories = await s.load();
      const archived = await s.loadArchive();
      expect(memories).toHaveLength(2);
      expect(archived).toHaveLength(1);
      expect(memories[0].id).not.toBe(archived[0].id);
    });

    it('should load/save episodes', async () => {
      const s = await fresh();
      const episodes = [{
        id: s.genEpisodeId(),
        name: 'Test Episode',
        summary: null,
        agents: ['a'],
        memoryIds: ['mem_1'],
        tags: [],
        timeRange: { start: '2026-01-01', end: '2026-01-02' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }];
      await s.saveEpisodes(episodes);
      const loaded = await s.loadEpisodes();
      expect(loaded.length).toBe(1);
      expect(loaded[0].name).toBe('Test Episode');
    });

    it('should load/save clusters', async () => {
      const s = await fresh();
      const clusters = [{
        id: s.genClusterId(),
        label: 'Test Cluster',
        description: null,
        memoryIds: ['mem_1'],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }];
      await s.saveClusters(clusters);
      const loaded = await s.loadClusters();
      expect(loaded.length).toBe(1);
      expect(loaded[0].label).toBe('Test Cluster');
    });

    // ── genId ──

    it('genId() returns a string', async () => {
      const s = await fresh();
      const id = s.genId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('genId() returns unique IDs', async () => {
      const s = await fresh();
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(s.genId());
      }
      expect(ids.size).toBe(100);
    });

    it('genId() returns a valid id format', async () => {
      const s = await fresh();
      const id = s.genId();
      // memoryStorage/jsonStorage use mem_ prefix, supabase uses plain UUID
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(8);
    });

    // cleanup after all tests
    it('cleanup', async () => {
      if (cleanup) await cleanup();
    });
  });
}
