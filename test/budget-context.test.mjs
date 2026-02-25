import { describe, it, expect } from 'vitest';
import { MemoryGraph, estimateTokens } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createTestGraph() {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config: { linkThreshold: 0.99 },
  });
}

function longParagraph(seed) {
  return `projectx ${seed} ${'details '.repeat(70)}${'notes '.repeat(70)}${'context '.repeat(70)}`.trim();
}

describe('Budget-aware context', () => {
  it('with maxTokens returns fewer memories than unlimited context', async () => {
    const graph = createTestGraph();
    for (let i = 0; i < 10; i++) {
      await graph.store('a', longParagraph(`item-${i}`), { category: 'fact', importance: 0.2 + (i / 100) });
    }

    const unlimited = await graph.context('a', 'projectx', { maxMemories: 10 });
    const limited = await graph.context('a', 'projectx', { maxMemories: 10, maxTokens: 200 });

    expect(limited.count).toBeLessThan(unlimited.count);
    expect(typeof limited.tokenEstimate).toBe('number');
    expect(limited.included).toBe(limited.count);
  });

  it('prefers high-value short memories over low-value long ones under budget', async () => {
    const graph = createTestGraph();
    const short = await graph.store('a', 'projectx critical decision', {
      category: 'decision',
      importance: 1.0,
      provenance: { source: 'user_explicit' },
    });
    const long = await graph.store('a', `projectx ${'background '.repeat(170)}`, {
      category: 'fact',
      importance: 0.1,
      provenance: { source: 'inference' },
    });

    const result = await graph.context('a', 'projectx', { maxMemories: 10, maxTokens: 140 });
    const ids = new Set(result.memories.map(m => m.id));
    const excludedIds = new Set(result.excludedReasons.map(r => r.id));

    expect(ids.has(short.id)).toBe(true);
    expect(ids.has(long.id)).toBe(false);
    expect(excludedIds.has(long.id)).toBe(true);
  });

  it('populates excludedReasons with budget reason', async () => {
    const graph = createTestGraph();
    for (let i = 0; i < 5; i++) {
      await graph.store('a', `projectx ${'large '.repeat(120)} ${i}`, { importance: 0.2 });
    }
    const result = await graph.context('a', 'projectx', { maxMemories: 5, maxTokens: 150 });
    expect(result.excluded).toBeGreaterThan(0);
    expect(result.excludedReasons.every(r => r.reason === 'budget')).toBe(true);
  });

  it('tokenEstimate is roughly length/4', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'projectx concise memory one', { importance: 0.8 });
    await graph.store('a', 'projectx concise memory two', { importance: 0.7 });
    const result = await graph.context('a', 'projectx', { maxMemories: 5, maxTokens: 220 });
    expect(result.tokenEstimate).toBe(estimateTokens(result.context));
  });

  it('without maxTokens preserves prior response shape', async () => {
    const graph = createTestGraph();
    await graph.store('a', 'projectx baseline memory');
    const result = await graph.context('a', 'projectx', { maxMemories: 5 });
    expect('tokenEstimate' in result).toBe(false);
    expect('included' in result).toBe(false);
    expect('excluded' in result).toBe(false);
    expect('excludedReasons' in result).toBe(false);
  });

  it('estimateTokens("hello world") is 3', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });
});

