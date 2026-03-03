import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noopEmbeddings, cosineSimilarity } from '../src/embeddings.mjs';

describe('noopEmbeddings', () => {
  it('embed() returns array of correct length for string input', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed('hello');
    assert.equal(out.length, 1);
  });

  it('embed() returns array of correct length for array input', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed(['a', 'b', 'c']);
    assert.equal(out.length, 3);
  });

  it('handles string input by wrapping into a single output element', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed('single');
    assert.deepEqual(out, [null]);
  });

  it('handles array input by returning one null per item', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed(['x', 'y']);
    assert.deepEqual(out, [null, null]);
  });

  it('handles empty string input', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed('');
    assert.deepEqual(out, [null]);
  });

  it('handles empty array input', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed([]);
    assert.deepEqual(out, []);
  });

  it('exposes expected name property', () => {
    const emb = noopEmbeddings();
    assert.equal(emb.name, 'noop');
  });

  it('exposes expected model property', () => {
    const emb = noopEmbeddings();
    assert.equal(emb.model, null);
  });

  it('returns consistent output format (array of null)', async () => {
    const emb = noopEmbeddings();
    const out = await emb.embed(['alpha', 'beta', 'gamma']);
    assert.ok(Array.isArray(out));
    assert.ok(out.every(v => v === null));
  });

  it('returns a fresh output array on each call', async () => {
    const emb = noopEmbeddings();
    const out1 = await emb.embed(['a', 'b']);
    const out2 = await emb.embed(['a', 'b']);
    assert.notEqual(out1, out2);
    assert.deepEqual(out1, out2);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const actual = cosineSimilarity([1, 2, 3], [1, 2, 3]);
    assert.ok(Math.abs(actual - 1.0) < 0.0001);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const actual = cosineSimilarity([1, 0, 0], [0, 1, 0]);
    assert.ok(Math.abs(actual - 0.0) < 0.0001);
  });

  it('returns a value between 0 and 1 for partially aligned vectors', () => {
    const actual = cosineSimilarity([1, 0], [1, 1]);
    assert.ok(actual > 0 && actual < 1);
  });

  it('matches expected partial similarity value', () => {
    const actual = cosineSimilarity([1, 0], [1, 1]);
    const expected = 1 / Math.sqrt(2);
    assert.ok(Math.abs(actual - expected) < 0.0001);
  });

  it('returns 1.0 for normalized identical vectors', () => {
    const actual = cosineSimilarity([0.6, 0.8], [0.6, 0.8]);
    assert.ok(Math.abs(actual - 1.0) < 0.0001);
  });

  it('returns 1.0 for single-element vectors in same direction', () => {
    const actual = cosineSimilarity([2], [4]);
    assert.ok(Math.abs(actual - 1.0) < 0.0001);
  });

  it('returns -1.0 for opposite vectors', () => {
    const actual = cosineSimilarity([1, 2, 3], [-1, -2, -3]);
    assert.ok(Math.abs(actual - (-1.0)) < 0.0001);
  });

  it('returns NaN when one vector is all zeros', () => {
    const actual = cosineSimilarity([0, 0, 0], [1, 2, 3]);
    assert.ok(Number.isNaN(actual));
  });

  it('returns NaN when both vectors are all zeros', () => {
    const actual = cosineSimilarity([0, 0], [0, 0]);
    assert.ok(Number.isNaN(actual));
  });

  it('handles large vectors and returns near 1.0 for identical inputs', () => {
    const a = Array.from({ length: 1000 }, (_, i) => i + 1);
    const b = Array.from({ length: 1000 }, (_, i) => i + 1);
    const actual = cosineSimilarity(a, b);
    assert.ok(Math.abs(actual - 1.0) < 0.0001);
  });
});
