import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createTestGraph(opts = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config: { linkThreshold: 0.1, ...(opts.config || {}) },
    ...opts,
  });
}

describe('Trust feedback', () => {
  it('dispute() increments disputes count', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Timezone is UTC', { provenance: { source: 'inference' } });

    const result = await graph.dispute(stored.id, { reason: 'conflicting evidence' });
    expect(result.disputes).toBe(1);
    expect(graph._byId(stored.id).disputes).toBe(1);
  });

  it('dispute() recomputes trust lower', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Language is English', { provenance: { source: 'inference' } });

    const before = graph._byId(stored.id).provenance.trust;
    const result = await graph.dispute(stored.id, { reason: 'incorrect' });
    expect(result.trust).toBeLessThan(before);
  });

  it('dispute() below threshold -> status becomes disputed', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Very old inferred fact', { provenance: { source: 'inference' } });
    const mem = graph._byId(stored.id);
    mem.created_at = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    mem.updated_at = mem.created_at;

    const result = await graph.dispute(stored.id, { reason: 'outdated' });
    expect(result.status).toBe('disputed');
    expect(graph._byId(stored.id).status).toBe('disputed');
    expect(result.trust).toBeLessThan(0.3);
  });

  it('dispute() on non-existent memory returns null', async () => {
    const graph = createTestGraph();
    const result = await graph.dispute('missing-id', { reason: 'n/a' });
    expect(result).toBeNull();
  });

  it('corroborate() increments corroboration count', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'User prefers dark mode', { provenance: { source: 'inference' } });

    const result = await graph.corroborate(stored.id);
    expect(result.corroboration).toBe(2);
    expect(graph._byId(stored.id).provenance.corroboration).toBe(2);
  });

  it('corroborate() recomputes trust higher', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Editor is vim', { provenance: { source: 'inference' } });

    const before = graph._byId(stored.id).provenance.trust;
    const result = await graph.corroborate(stored.id);
    expect(result.trust).toBeGreaterThan(before);
  });

  it('corroborate() on non-existent memory returns null', async () => {
    const graph = createTestGraph();
    const result = await graph.corroborate('missing-id');
    expect(result).toBeNull();
  });

  it('reinforce() increments reinforcements', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Important policy note', { provenance: { source: 'inference' } });

    const result = await graph.reinforce(stored.id, 0.1);
    expect(result.reinforcements).toBe(1);
    expect(graph._byId(stored.id).reinforcements).toBe(1);
  });

  it('reinforce() recomputes confidence', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Confidence should change', { provenance: { source: 'inference' } });

    const before = graph._byId(stored.id).provenance.trust;
    const result = await graph.reinforce(stored.id, 0.1);
    expect(result.confidence).toBeGreaterThan(before);
    expect(graph._byId(stored.id).confidence).toBe(result.confidence);
  });

  it('multiple disputes drive trust below threshold', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Old debatable memory', { provenance: { source: 'inference' } });
    const mem = graph._byId(stored.id);
    mem.created_at = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString();
    mem.updated_at = mem.created_at;

    await graph.dispute(stored.id, { reason: 'bad' });
    await graph.dispute(stored.id, { reason: 'still bad' });

    const updated = graph._byId(stored.id);
    expect(updated.provenance.trust).toBeLessThan(0.3);
    expect(updated.status).toBe('disputed');
  });

  it('dispute + corroborate interactions balance out', async () => {
    const graph = createTestGraph();
    const stored = await graph.store('a', 'Needs verification', { provenance: { source: 'inference' } });

    const afterDispute = await graph.dispute(stored.id, { reason: 'uncertain' });
    const afterCorroborate = await graph.corroborate(stored.id);

    expect(afterCorroborate.trust).toBeGreaterThan(afterDispute.trust);
    expect(afterCorroborate.confidence).toBeGreaterThan(afterDispute.confidence);
  });
});
