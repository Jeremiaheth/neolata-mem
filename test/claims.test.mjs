import { describe, it, expect } from 'vitest';
import { MemoryGraph, computeTrust, computeConfidence } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';

function fakeEmbeddings() {
  return {
    name: 'fake',
    model: 'fake',
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
    embeddings: opts.embeddings || fakeEmbeddings(),
    config: opts.config || {},
    ...opts,
  });
}

describe('Claim-based memory model', () => {
  it('store with claim attaches claim field', async () => {
    const graph = createTestGraph();
    const claim = { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' };
    const result = await graph.store('a', 'User timezone is UTC', { claim });
    const mem = graph.memories.find(m => m.id === result.id);
    expect(mem.claim).toBeTruthy();
    expect(mem.claim.subject).toBe('user');
    expect(mem.claim.predicate).toBe('timezone');
  });

  it('store with claim indexes claim in _claimIndex', async () => {
    const graph = createTestGraph();
    const claim = { subject: 'user', predicate: 'lang', value: 'en', scope: 'global' };
    const result = await graph.store('a', 'User language is English', { claim });
    const key = 'user::lang';
    expect(graph._claimIndex.get(key)?.has(result.id)).toBeTruthy();
  });

  it('_structuralConflictCheck finds conflicting exclusive claims', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Color is blue', {
      claim: { subject: 'user', predicate: 'theme', value: 'blue', scope: 'global' },
    });
    const conflicts = graph._structuralConflictCheck({
      subject: 'user', predicate: 'theme', value: 'green', scope: 'global', exclusive: true,
    });
    expect(conflicts.length).toBe(1);
  });

  it('_structuralConflictCheck ignores same-value claims (not a conflict)', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Color is blue', {
      claim: { subject: 'user', predicate: 'theme', value: 'blue', scope: 'global' },
    });
    const conflicts = graph._structuralConflictCheck({
      subject: 'user', predicate: 'theme', value: 'blue', scope: 'global', exclusive: true,
    });
    expect(conflicts.length).toBe(0);
  });

  it('_structuralConflictCheck ignores superseded/quarantined memories', async () => {
    const graph = createTestGraph();
    const r1 = await graph.store('a', 'Color is blue', {
      claim: { subject: 'user', predicate: 'theme', value: 'blue', scope: 'global' },
    });
    const mem = graph._byId(r1.id);
    mem.status = 'superseded';
    const conflicts = graph._structuralConflictCheck({
      subject: 'user', predicate: 'theme', value: 'green', scope: 'global', exclusive: true,
    });
    expect(conflicts.length).toBe(0);
  });

  it('_structuralConflictCheck ignores non-exclusive predicates (exclusive: false)', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Tag is backend', {
      claim: { subject: 'user', predicate: 'tags', value: 'backend', scope: 'global', exclusive: false },
    });
    const conflicts = graph._structuralConflictCheck({
      subject: 'user', predicate: 'tags', value: 'frontend', scope: 'global', exclusive: true,
    });
    expect(conflicts.length).toBe(0);
  });

  it('_structuralConflictCheck ignores non-overlapping validity windows', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Role was engineer', {
      claim: {
        subject: 'user',
        predicate: 'role',
        value: 'engineer',
        scope: 'temporal',
        validFrom: '2024-01-01T00:00:00Z',
        validUntil: '2024-06-01T00:00:00Z',
      },
    });
    const conflicts = graph._structuralConflictCheck({
      subject: 'user',
      predicate: 'role',
      value: 'manager',
      scope: 'temporal',
      exclusive: true,
      validFrom: '2025-01-01T00:00:00Z',
      validUntil: '2025-06-01T00:00:00Z',
    });
    expect(conflicts.length).toBe(0);
  });

  it('_structuralConflictCheck detects overlapping validity windows', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Role was engineer', {
      claim: {
        subject: 'user',
        predicate: 'role',
        value: 'engineer',
        scope: 'temporal',
        validFrom: '2024-01-01T00:00:00Z',
        validUntil: '2024-12-01T00:00:00Z',
      },
    });
    const conflicts = graph._structuralConflictCheck({
      subject: 'user',
      predicate: 'role',
      value: 'manager',
      scope: 'temporal',
      exclusive: true,
      validFrom: '2024-06-01T00:00:00Z',
      validUntil: '2025-01-01T00:00:00Z',
    });
    expect(conflicts.length).toBe(1);
  });

  it('_structuralConflictCheck: session-scoped claim does not conflict with global', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Global timezone UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
    });
    const conflicts = graph._structuralConflictCheck({
      subject: 'user',
      predicate: 'timezone',
      value: 'PST',
      scope: 'session',
      sessionId: 's1',
      exclusive: true,
    });
    expect(conflicts.length).toBe(0);
  });

  it('store same (subject, predicate, value) dedups and corroborates existing', async () => {
    const graph = createTestGraph();
    const claim = { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' };
    const first = await graph.store('a', 'Timezone is UTC', { claim });
    const second = await graph.store('a', 'Timezone also UTC', { claim });
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(graph.memories.length).toBe(1);
    expect(graph._byId(first.id).provenance.corroboration).toBe(2);
  });

  it('store without claim remains backward compatible (no claim field)', async () => {
    const graph = createTestGraph();
    const result = await graph.store('a', 'Normal memory');
    const mem = graph._byId(result.id);
    expect(mem.claim).toBeUndefined();
  });

  it('claim validation throws on missing subject/predicate', async () => {
    const graph = createTestGraph();
    await expect(graph.store('a', 'Bad claim', {
      claim: { predicate: 'timezone', value: 'UTC', scope: 'global' },
    })).rejects.toThrow(/claim\.subject/);
    await expect(graph.store('a', 'Bad claim', {
      claim: { subject: 'user', value: 'UTC', scope: 'global' },
    })).rejects.toThrow(/claim\.predicate/);
  });

  it('claim validation throws when scope=session but sessionId missing', async () => {
    const graph = createTestGraph();
    await expect(graph.store('a', 'Bad session claim', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'session' },
    })).rejects.toThrow(/sessionId/);
  });

  it('provenance defaults applied when not specified', async () => {
    const graph = createTestGraph();
    const result = await graph.store('a', 'Default provenance');
    const mem = graph._byId(result.id);
    expect(mem.provenance).toEqual({ source: 'inference', corroboration: 1, trust: 0.5 });
  });

  it('computeTrust with user_explicit is 1.0', () => {
    expect(computeTrust({ source: 'user_explicit', corroboration: 1 })).toBe(1.0);
  });

  it('computeTrust with inference is 0.5', () => {
    expect(computeTrust({ source: 'inference', corroboration: 1 })).toBe(0.5);
  });

  it('computeTrust applies corroboration bonus', () => {
    expect(computeTrust({ source: 'inference', corroboration: 3 })).toBe(0.6);
  });

  it('computeTrust disputes reduce trust', () => {
    expect(computeTrust({ source: 'inference', corroboration: 1 }, 0, 2)).toBeLessThan(0.5);
  });

  it('computeConfidence equals trust score (no double-counting)', () => {
    const mem = { provenance: { trust: 0.73456 } };
    expect(computeConfidence(mem)).toBe(0.7346);
  });

  it('deindex removes from _claimIndex', async () => {
    const graph = createTestGraph();
    const claim = { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' };
    const result = await graph.store('a', 'Timezone UTC', { claim });
    const mem = graph._byId(result.id);
    graph._deindexMemory(mem);
    expect(graph._claimIndex.has('user::timezone')).toBe(false);
  });

  it('rebuildIndexes rebuilds _claimIndex', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'Timezone UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
    });
    graph._claimIndex.clear();
    expect(graph._claimIndex.size).toBe(0);
    graph._rebuildIndexes();
    expect(graph._claimIndex.has('user::timezone')).toBe(true);
  });

  it('claim defaults exclusive to true when not specified', async () => {
    const graph = createTestGraph();
    const result = await graph.store('a', 'Timezone UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
    });
    expect(graph._byId(result.id).claim.exclusive).toBe(true);
  });
});
