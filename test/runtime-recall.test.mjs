import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/index.mjs';
import { extractTopicSlug, contextualRecall } from '../src/runtime.mjs';

function createTestMemory() {
  return createMemory({
    storage: { type: 'memory' },
    embeddings: { type: 'noop' },
  });
}

describe('extractTopicSlug', () => {
  it('returns the most frequent non-stop-word (ties alphabetically)', () => {
    expect(extractTopicSlug('Fix the OCI deployment pipeline')).toBe('deployment');
  });

  it('maps alias to configured synonym slug', () => {
    expect(extractTopicSlug('oracle tenancy oracle migration', {
      synonyms: { oci: ['oracle', 'tenancy'] },
    })).toBe('oci');
  });

  it('returns null for empty input', () => {
    expect(extractTopicSlug('')).toBeNull();
  });

  it('returns null when all words are stop words', () => {
    expect(extractTopicSlug('the a an is')).toBeNull();
  });
});

describe('contextualRecall', () => {
  it('returns blended results across channels', async () => {
    const mem = createTestMemory();
    const m1 = await mem.store('agent-a', 'Team lunch on friday', { importance: 0.2 });
    const m2 = await mem.store('agent-a', 'Fix OCI deployment pipeline for staging release', { importance: 0.6 });
    const m3 = await mem.store('agent-a', 'Oracle tenancy policy updated for production', { importance: 0.95 });

    const result = await contextualRecall(mem, 'agent-a', 'oracle pipeline', {
      recentCount: 5,
      semanticCount: 5,
      importantCount: 5,
      maxTokens: 2000,
      synonyms: { oci: ['oracle', 'tenancy'] },
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain(m1.id);
    expect(ids).toContain(m2.id);
    expect(ids).toContain(m3.id);
  });

  it('deduplicates memories returned by multiple channels', async () => {
    const mem = createTestMemory();
    const target = await mem.store('agent-a', 'Fix OCI deployment pipeline now', { importance: 0.9 });
    await mem.store('agent-a', 'General chatter about weather', { importance: 0.2 });

    const result = await contextualRecall(mem, 'agent-a', 'OCI deployment pipeline', {
      recentCount: 5,
      semanticCount: 5,
      importantCount: 5,
      maxTokens: 2000,
      synonyms: { oci: ['oracle', 'tenancy'] },
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids.filter((id) => id === target.id)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('respects maxTokens budget', async () => {
    const mem = createTestMemory();
    await mem.store('agent-a', 'A very long memory about deployment and pipelines repeated many times for budget checks', { importance: 0.95 });
    await mem.store('agent-a', 'Another fairly long memory that should likely be excluded under tiny token limits', { importance: 0.9 });

    const result = await contextualRecall(mem, 'agent-a', 'deployment pipeline', {
      recentCount: 5,
      semanticCount: 5,
      importantCount: 5,
      maxTokens: 1,
    });

    expect(result.totalTokens).toBeLessThanOrEqual(1);
    expect(result.excluded).toBeGreaterThanOrEqual(1);
  });

  it('returns topicSlug in the response', async () => {
    const mem = createTestMemory();
    await mem.store('agent-a', 'Oracle tenancy setup complete', { importance: 0.9 });

    const result = await contextualRecall(mem, 'agent-a', 'oracle oracle migration', {
      synonyms: { oci: ['oracle', 'tenancy'] },
    });

    expect(result.topicSlug).toBe('oci');
  });

  it('filters Channel C by importance threshold', async () => {
    const mem = createTestMemory();
    const low = await mem.store('agent-a', 'Pipeline run failed in QA', { importance: 0.7 });
    const high = await mem.store('agent-a', 'Pipeline release gate approved', { importance: 0.95 });

    const result = await contextualRecall(mem, 'agent-a', 'pipeline', {
      recentCount: 0,
      semanticCount: 0,
      importantCount: 10,
      importanceThreshold: 0.9,
      maxTokens: 2000,
    });

    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain(high.id);
    expect(ids).not.toContain(low.id);
    expect(result.memories.every((m) => (m.importance || 0) >= 0.9)).toBe(true);
  });
});
