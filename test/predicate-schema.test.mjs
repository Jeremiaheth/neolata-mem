import { describe, it, expect } from 'vitest';
import { MemoryGraph, normalizeClaim } from '../src/graph.mjs';
import { createMemory, normalizeClaim as normalizeClaimFromIndex } from '../src/index.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';

function createGraph(config = {}) {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
    config,
  });
}

describe('Predicate Schema Registry', () => {
  it('schema CRUD: register/get/list', () => {
    const graph = createGraph({
      predicateSchemas: {
        budget_is: { normalize: 'currency' },
      },
    });

    const seeded = graph.getPredicateSchema('budget_is');
    expect(seeded).toEqual({
      predicate: 'budget_is',
      cardinality: 'single',
      conflictPolicy: 'supersede',
      normalize: 'currency',
      dedupPolicy: 'corroborate',
    });

    graph.registerPredicate('likes', {
      cardinality: 'multi',
      conflictPolicy: 'keep_both',
      normalize: 'lowercase_trim',
    });
    graph.registerPredicates({
      timezone: {},
    });

    const likes = graph.getPredicateSchema('likes');
    expect(likes.cardinality).toBe('multi');
    expect(likes.conflictPolicy).toBe('keep_both');
    expect(likes.dedupPolicy).toBe('corroborate');

    const list = graph.listPredicateSchemas();
    expect(Object.keys(list).sort()).toEqual(['budget_is', 'likes', 'timezone']);
    expect(list.timezone.conflictPolicy).toBe('supersede');
  });

  it('factory passes predicateSchemas and index re-exports normalizeClaim', () => {
    const mem = createMemory({
      storage: { type: 'memory' },
      predicateSchemas: {
        prefers: { cardinality: 'multi', normalize: 'lowercase_trim' },
      },
    });

    expect(mem.getPredicateSchema('prefers').cardinality).toBe('multi');

    const claim = { subject: 'user', predicate: 'city', value: ' Seattle ', scope: 'global' };
    expect(normalizeClaimFromIndex(claim, 'lowercase_trim').normalizedValue).toBe('seattle');
  });

  it('multi predicate does not create conflict on different values', async () => {
    const graph = createGraph({
      predicateSchemas: {
        likes: { cardinality: 'multi', conflictPolicy: 'keep_both' },
      },
    });

    const a = await graph.store('a', 'User likes pizza', {
      claim: { subject: 'user', predicate: 'likes', value: 'pizza', scope: 'global' },
    });
    const b = await graph.store('a', 'User likes sushi', {
      claim: { subject: 'user', predicate: 'likes', value: 'sushi', scope: 'global' },
    });

    expect(graph._byId(a.id).status).toBe('active');
    expect(graph._byId(b.id).status).toBe('active');
    expect((await graph.pendingConflicts()).length).toBe(0);
  });

  it('multi predicate with same normalizedValue corroborates existing memory', async () => {
    const graph = createGraph({
      predicateSchemas: {
        likes: { cardinality: 'multi', normalize: 'lowercase_trim', dedupPolicy: 'corroborate' },
      },
    });

    const first = await graph.store('a', 'User likes Seattle', {
      claim: { subject: 'user', predicate: 'likes', value: ' Seattle ', scope: 'global' },
    });
    const second = await graph.store('a', 'User likes seattle', {
      claim: { subject: 'user', predicate: 'likes', value: 'seattle', scope: 'global' },
    });

    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(graph.memories).toHaveLength(1);
    expect(graph._byId(first.id).claim.normalizedValue).toBe('seattle');
    expect(graph._byId(first.id).provenance.corroboration).toBe(2);
  });

  it('single + require_review always quarantines on conflict', async () => {
    const graph = createGraph({
      predicateSchemas: {
        timezone: { cardinality: 'single', conflictPolicy: 'require_review' },
      },
    });

    await graph.store('a', 'Timezone is UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
      provenance: { source: 'inference' },
    });
    const newer = await graph.store('a', 'Timezone is PST', {
      claim: { subject: 'user', predicate: 'timezone', value: 'PST', scope: 'global' },
      provenance: { source: 'user_explicit' },
    });

    expect(graph._byId(newer.id).status).toBe('quarantined');
    const pending = await graph.pendingConflicts();
    expect(pending).toHaveLength(1);
    expect(pending[0].newId).toBe(newer.id);
  });

  it('single + keep_both keeps both memories active', async () => {
    const graph = createGraph({
      predicateSchemas: {
        timezone: { cardinality: 'single', conflictPolicy: 'keep_both' },
      },
    });

    const first = await graph.store('a', 'Timezone is UTC', {
      claim: { subject: 'user', predicate: 'timezone', value: 'UTC', scope: 'global' },
    });
    const second = await graph.store('a', 'Timezone is PST', {
      claim: { subject: 'user', predicate: 'timezone', value: 'PST', scope: 'global' },
    });

    expect(graph._byId(first.id).status).toBe('active');
    expect(graph._byId(second.id).status).toBe('active');
    expect((await graph.pendingConflicts())).toHaveLength(0);

    const allConflicts = await graph.conflicts({ includeResolved: true });
    expect(allConflicts).toHaveLength(1);
    expect(allConflicts[0].resolution).toBe('keep_both');
  });

  it('currency normalization maps variants to CUR AMOUNT', () => {
    const base = { subject: 'user', predicate: 'budget_is', scope: 'global' };

    expect(normalizeClaim({ ...base, value: 'dollar750' }, 'currency').normalizedValue).toBe('USD 750');
    expect(normalizeClaim({ ...base, value: '750 USD' }, 'currency').normalizedValue).toBe('USD 750');
    expect(normalizeClaim({ ...base, value: 'euro50' }, 'currency').normalizedValue).toBe('EUR 50');
    expect(normalizeClaim({ ...base, value: 'roughly a lot' }, 'currency').normalizedValue).toBe('roughly a lot');
  });

  it('no schema configured keeps v0.8 default single+supersede behavior', async () => {
    const graph = createGraph();

    const old = await graph.store('a', 'Theme is blue', {
      claim: { subject: 'user', predicate: 'theme', value: 'blue', scope: 'global' },
    });
    const newer = await graph.store('a', 'Theme is green', {
      claim: { subject: 'user', predicate: 'theme', value: 'green', scope: 'global' },
    });

    expect(graph._byId(old.id).status).toBe('superseded');
    expect(graph._byId(old.id).superseded_by).toBe(newer.id);
    expect(graph._byId(newer.id).status).toBe('active');
  });
});
