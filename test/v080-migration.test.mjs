import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { jsonStorage, memoryStorage } from '../src/storage.mjs';

describe('v0.8 Storage Migration', () => {
  it('jsonStorage loads/saves pending conflicts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-v080-'));
    try {
      const storage = jsonStorage({ dir });
      const conflicts = [{
        id: 'c1',
        newId: 'mem_new',
        existingId: 'mem_old',
        newTrust: 0.6,
        existingTrust: 0.9,
        newClaim: { subject: 'user', predicate: 'budget_is', value: '$750' },
        existingClaim: { subject: 'user', predicate: 'budget_is', value: '$500' },
        created_at: '2026-01-01T00:00:00.000Z',
      }];
      await storage.savePendingConflicts(conflicts);
      const loaded = await storage.loadPendingConflicts();
      expect(loaded).toEqual(conflicts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('memoryStorage loads/saves pending conflicts', async () => {
    const storage = memoryStorage();
    const conflicts = [{
      id: 'c2',
      newId: 'mem_new',
      existingId: 'mem_old',
      newTrust: 0.4,
      existingTrust: 0.8,
      created_at: '2026-01-02T00:00:00.000Z',
    }];
    await storage.savePendingConflicts(conflicts);
    const loaded = await storage.loadPendingConflicts();
    expect(loaded).toEqual(conflicts);
  });

  it('memories without v0.8 fields still load correctly (backward compat)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-v080-'));
    try {
      const storage = jsonStorage({ dir });
      const oldMemory = [{
        id: 'mem_old',
        agent: 'agent-1',
        memory: 'Legacy memory shape',
        category: 'fact',
        importance: 0.5,
        tags: [],
        embedding: null,
        links: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }];
      await storage.save(oldMemory);
      const loaded = await storage.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('mem_old');
      expect(loaded[0].status).toBeUndefined();
      expect(loaded[0].provenance).toBeUndefined();
      expect(loaded[0].claim).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('store with provenance is persisted and reloaded correctly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-v080-'));
    try {
      const storage = jsonStorage({ dir });
      const mem = [{
        id: 'mem_v080',
        agent: 'agent-1',
        memory: 'User budget is $500',
        category: 'fact',
        importance: 0.9,
        tags: ['budget'],
        embedding: null,
        links: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        claim: { subject: 'user', predicate: 'budget_is', value: '$500', scope: 'global' },
        provenance: { source: 'user_explicit', corroboration: 2, trust: 1.0 },
        confidence: 1.0,
        status: 'active',
        reinforcements: 1,
        disputes: 0,
      }];
      await storage.save(mem);
      const loaded = await storage.load();
      expect(loaded[0].claim).toEqual(mem[0].claim);
      expect(loaded[0].provenance).toEqual(mem[0].provenance);
      expect(loaded[0].confidence).toBe(1.0);
      expect(loaded[0].status).toBe('active');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
