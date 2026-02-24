import { describe, it, expect, beforeEach } from 'vitest';
import { supabaseStorage } from '../src/supabase-storage.mjs';
import { createMockSupabase } from './mock-supabase.mjs';

/**
 * Tests for incremental Supabase operations (upsert, remove, upsertLinks, removeLinks).
 * These bypass the full save() cycle for efficiency.
 */

describe('supabaseStorage incremental ops', () => {
  let mock, storage;

  beforeEach(() => {
    mock = createMockSupabase();
    storage = supabaseStorage({
      url: 'https://test.supabase.co',
      key: 'test-key',
      fetch: mock.fetch,
    });
  });

  // ── upsert ──

  it('upsert() inserts a new memory', async () => {
    const mem = {
      id: 'mem_1', agent: 'a1', memory: 'Test', category: 'fact',
      importance: 0.7, tags: [], embedding: [0.1, 0.2],
      links: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    await storage.upsert(mem);
    const loaded = await storage.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('mem_1');
    expect(loaded[0].memory).toBe('Test');
  });

  it('upsert() updates an existing memory', async () => {
    const mem = {
      id: 'mem_1', agent: 'a1', memory: 'Version 1', category: 'fact',
      importance: 0.5, tags: [], embedding: null,
      links: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    await storage.upsert(mem);

    const updated = { ...mem, memory: 'Version 2', importance: 0.9 };
    await storage.upsert(updated);

    const loaded = await storage.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].memory).toBe('Version 2');
    expect(loaded[0].importance).toBe(0.9);
  });

  // ── remove ──

  it('remove() deletes a memory by id', async () => {
    const mem = {
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', agent: 'a1', memory: 'Gone', category: 'fact',
      importance: 0.5, tags: [], embedding: null,
      links: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    await storage.upsert(mem);
    expect((await storage.load())).toHaveLength(1);

    await storage.remove('aaaaaaaa-bbbb-cccc-dddd-000000000001');
    expect((await storage.load())).toHaveLength(0);
  });

  it('remove() is a no-op for non-existent id', async () => {
    // Should not throw
    await storage.remove('aaaaaaaa-bbbb-cccc-dddd-000000000099');
  });

  // ── upsertLinks ──

  it('upsertLinks() inserts link rows', async () => {
    // Set up two memories first
    await storage.upsert({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002', agent: 'a1', memory: 'A', category: 'fact',
      importance: 0.5, tags: [], embedding: null, links: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    await storage.upsert({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000003', agent: 'a1', memory: 'B', category: 'fact',
      importance: 0.5, tags: [], embedding: null, links: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });

    await storage.upsertLinks('aaaaaaaa-bbbb-cccc-dddd-000000000002', [{ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000003', similarity: 0.85 }]);

    // Load and check links are attached
    const loaded = await storage.load();
    const memA = loaded.find(m => m.id === 'aaaaaaaa-bbbb-cccc-dddd-000000000002');
    const memB = loaded.find(m => m.id === 'aaaaaaaa-bbbb-cccc-dddd-000000000003');
    // Bidirectional
    expect(memA.links.some(l => l.id === 'aaaaaaaa-bbbb-cccc-dddd-000000000003')).toBe(true);
    expect(memB.links.some(l => l.id === 'aaaaaaaa-bbbb-cccc-dddd-000000000002')).toBe(true);
  });

  // ── removeLinks ──

  it('removeLinks() removes all links for a memory', async () => {
    await storage.upsert({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000004', agent: 'a1', memory: 'X', category: 'fact',
      importance: 0.5, tags: [], embedding: null, links: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    await storage.upsert({
      id: 'aaaaaaaa-bbbb-cccc-dddd-000000000005', agent: 'a1', memory: 'Y', category: 'fact',
      importance: 0.5, tags: [], embedding: null, links: [],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    });
    await storage.upsertLinks('aaaaaaaa-bbbb-cccc-dddd-000000000004', [{ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000005', similarity: 0.9 }]);

    await storage.removeLinks('aaaaaaaa-bbbb-cccc-dddd-000000000004');

    const loaded = await storage.load();
    const memX = loaded.find(m => m.id === 'aaaaaaaa-bbbb-cccc-dddd-000000000004');
    const memY = loaded.find(m => m.id === 'aaaaaaaa-bbbb-cccc-dddd-000000000005');
    expect(memX.links).toHaveLength(0);
    expect(memY.links).toHaveLength(0);
  });

  // ── server-side search ──

  it('search() delegates to RPC when available', async () => {
    // Seed a memory row directly
    const memTable = mock.getTable('memories');
    memTable.push({
      id: 'mem_s1', agent_id: 'a1', content: 'Dark mode preference',
      category: 'preference', importance: 0.8, tags: ['ui'],
      embedding: JSON.stringify([0.1, 0.2, 0.3]),
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      access_count: 0,
    });

    // The storage.search method should exist
    expect(typeof storage.search).toBe('function');

    // Our mock doesn't implement RPCs, so it should fall back gracefully
    // (returns null on RPC failure, so MemoryGraph falls back to client-side)
    const result = await storage.search([0.1, 0.2, 0.3], { agent: 'a1', limit: 5 });
    // Mock doesn't support RPC → returns null
    expect(result).toBeNull();
  });

  // ── hasIncremental flag ──

  it('exposes incremental: true flag', () => {
    expect(storage.incremental).toBe(true);
  });

  // ── Security: UUID validation ──

  it('remove() rejects non-UUID ids (injection prevention)', async () => {
    await expect(storage.remove('anything,id.neq.null)&select=*--'))
      .rejects.toThrow('must be a valid UUID');
  });

  it('upsertLinks() rejects non-UUID sourceId', async () => {
    await expect(storage.upsertLinks('evil_injection', [{ id: 'aaaaaaaa-bbbb-cccc-dddd-000000000002', similarity: 0.5 }]))
      .rejects.toThrow('must be a valid UUID');
  });

  it('removeLinks() rejects non-UUID memoryId', async () => {
    await expect(storage.removeLinks('../../../etc/passwd'))
      .rejects.toThrow('must be a valid UUID');
  });
});
