import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createGraph() {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config: { linkThreshold: 0.99 },
  });
}

describe('Explainability API', () => {
  it('search({ explain: true }) returns array with .meta and returned count matches length', async () => {
    const graph = createGraph();
    await graph.store('a', 'project alpha budget baseline');
    await graph.store('a', 'project alpha budget decision');

    const results = await graph.search('a', 'project alpha budget', { explain: true, limit: 5 });

    expect(Array.isArray(results)).toBe(true);
    expect(results.meta).toBeTruthy();
    expect(results.meta.query).toBe('project alpha budget');
    expect(results.meta.agent).toBe('a');
    expect(results.meta.counts.returned).toBe(results.length);
  });

  it('search explain items include retrieved and rerank sections', async () => {
    const graph = createGraph();
    await graph.store('a', 'alpha retrieval evidence');

    const results = await graph.search('a', 'alpha retrieval', { explain: true });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].explain).toBeTruthy();
    expect(results[0].explain.retrieved).toBeTruthy();
    expect(results[0].explain.rerank).toBeTruthy();
    expect(typeof results[0].explain.rerank.compositeScore).toBe('number');
  });

  it('search explain excluded breakdown increments superseded and quarantined', async () => {
    const graph = createGraph();
    const active = await graph.store('a', 'status explain active');
    const superseded = await graph.store('a', 'status explain superseded');
    const quarantined = await graph.store('a', 'status explain quarantined');

    graph._byId(active.id).status = 'active';
    graph._byId(superseded.id).status = 'superseded';
    graph._byId(quarantined.id).status = 'quarantined';

    const results = await graph.search('a', 'status explain', { explain: true });
    expect(results.meta.excluded.superseded).toBeGreaterThanOrEqual(1);
    expect(results.meta.excluded.quarantined).toBeGreaterThanOrEqual(1);
  });

  it('context({ explain: true }) includes packing explain', async () => {
    const graph = createGraph();
    await graph.store('a', `projectx ${'detail '.repeat(80)}`, { importance: 0.1 });
    await graph.store('a', 'projectx concise decision', { category: 'decision', importance: 1.0 });

    const ctx = await graph.context('a', 'projectx', { maxMemories: 10, maxTokens: 140, explain: true });
    expect(ctx.explain).toBeTruthy();
    expect(ctx.explain.searchMeta).toBeTruthy();
    expect(ctx.explain.packing).toBeTruthy();
    expect(Array.isArray(ctx.explain.packing.includedIds)).toBe(true);
    expect(Array.isArray(ctx.explain.packing.excluded)).toBe(true);
  });

  it('explainMemory() returns status/trust/confidence + provenance + claim summary', async () => {
    const graph = createGraph();
    const stored = await graph.store('a', 'Timezone is UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const info = await graph.explainMemory(stored.id);
    expect(info).toBeTruthy();
    expect(info.id).toBe(stored.id);
    expect(info.status).toBe('active');
    expect(typeof info.trust).toBe('number');
    expect(typeof info.confidence).toBe('number');
    expect(info.provenance.source).toBe('user_explicit');
    expect(info.claimSummary.subject).toBe('user');
    expect(info.claimSummary.predicate).toBe('timezone');
  });

  it('explainSupersession() returns superseding memory + trust comparison for superseded memory', async () => {
    const graph = createGraph();
    const old = await graph.store('a', 'Theme is blue', {
      claim: { subject: 'user', predicate: 'theme', value: 'blue', scope: 'global' },
      provenance: { source: 'inference' },
    });
    const newer = await graph.store('a', 'Theme is green', {
      claim: { subject: 'user', predicate: 'theme', value: 'green', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    const sup = await graph.explainSupersession(old.id);
    expect(sup).toBeTruthy();
    expect(sup.superseded).toBe(true);
    expect(sup.supersededBy.id).toBe(newer.id);
    expect(typeof sup.trustComparison.original).toBe('number');
    expect(typeof sup.trustComparison.superseding).toBe('number');
  });

  it('without explain: output remains unchanged (search/context)', async () => {
    const graph = createGraph();
    await graph.store('a', 'baseline output memory');

    const searchDefault = await graph.search('a', 'baseline output', { limit: 5 });
    const searchExplicitFalse = await graph.search('a', 'baseline output', { limit: 5, explain: false });
    expect(searchExplicitFalse).toEqual(searchDefault);
    expect('meta' in searchDefault).toBe(false);
    expect(searchDefault[0].explain).toBeUndefined();

    const ctxDefault = await graph.context('a', 'baseline output', { maxMemories: 5 });
    const ctxExplicitFalse = await graph.context('a', 'baseline output', { maxMemories: 5, explain: false });
    expect(ctxExplicitFalse).toEqual(ctxDefault);
    expect(ctxDefault.explain).toBeUndefined();
  });
});
