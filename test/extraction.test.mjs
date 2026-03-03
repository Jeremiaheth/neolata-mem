import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { llmExtraction, passthroughExtraction } from '../src/extraction.mjs';

describe('passthroughExtraction', () => {
  it('text passthrough (input returned as-is)', async () => {
    const ext = passthroughExtraction();
    const input = 'Redis runs on port 6379';
    const out = await ext.extract(input);
    assert.equal(out[0].fact, input);
  });

  it('no transformation, exact match', async () => {
    const ext = passthroughExtraction();
    const input = '  Keep this string exactly as-is!  ';
    const out = await ext.extract(input);
    assert.equal(out[0].fact, input);
  });

  it('array handling', async () => {
    const ext = passthroughExtraction();
    const input = ['a', 'b', 'c'];
    const out = await ext.extract(input);
    assert.deepEqual(out[0].fact, input);
  });

  it('empty input handling', async () => {
    const ext = passthroughExtraction();
    const out = await ext.extract('');
    assert.equal(out[0].fact, '');
    assert.deepEqual(out, [{ fact: '', category: 'fact', importance: 0.5, tags: [] }]);
  });

  it('uses default category and importance', async () => {
    const ext = passthroughExtraction();
    const out = await ext.extract('x');
    assert.equal(out[0].category, 'fact');
    assert.equal(out[0].importance, 0.5);
  });

  it('supports custom category and importance', async () => {
    const ext = passthroughExtraction({ defaultCategory: 'event', defaultImportance: 0.9 });
    const out = await ext.extract('deployed');
    assert.equal(out[0].category, 'event');
    assert.equal(out[0].importance, 0.9);
  });

  it('returns provider with expected name', () => {
    const ext = passthroughExtraction();
    assert.equal(ext.name, 'passthrough');
  });

  it('extract() method exists and is callable', async () => {
    const ext = passthroughExtraction();
    assert.equal(typeof ext.extract, 'function');
    await assert.doesNotReject(() => ext.extract('callable'));
  });
});

describe('llmExtraction', () => {
  it('constructor accepts apiKey/model/baseUrl', () => {
    assert.doesNotThrow(() => {
      llmExtraction({
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        baseUrl: 'https://example.test/v1',
      });
    });
  });

  it('extract() method exists and is callable', () => {
    const ext = llmExtraction({ apiKey: 'test-key' });
    assert.equal(typeof ext.extract, 'function');
  });

  it('does not throw when apiKey is missing', () => {
    assert.doesNotThrow(() => llmExtraction({}));
  });

  it('default model fallback reflected in provider name', () => {
    const ext = llmExtraction({ apiKey: 'test-key' });
    assert.equal(ext.name, 'llm(gpt-4.1-nano)');
  });
});
