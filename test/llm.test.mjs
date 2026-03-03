import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openaiChat } from '../src/llm.mjs';

describe('openaiChat', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('constructor accepts apiKey/model/baseUrl', () => {
    assert.doesNotThrow(() => {
      openaiChat({
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        baseUrl: 'https://example.test/v1',
      });
    });
  });

  it('has chat() method', () => {
    const llm = openaiChat({ apiKey: 'test-key' });
    assert.equal(typeof llm.chat, 'function');
  });

  it('name property includes openai-chat prefix', () => {
    const llm = openaiChat({ apiKey: 'test-key' });
    assert.ok(llm.name.startsWith('openai-chat('));
  });

  it('name property reflects configured model', () => {
    const llm = openaiChat({ apiKey: 'test-key', model: 'gpt-4o-mini' });
    assert.equal(llm.name, 'openai-chat(gpt-4o-mini)');
  });

  it('default model fallback', async () => {
    let payload;
    globalThis.fetch = async (_url, init) => {
      payload = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    const llm = openaiChat({ apiKey: 'test-key' });
    await llm.chat('ping');
    assert.equal(payload.model, 'gpt-4.1-nano');
  });

  it('baseUrl configuration', async () => {
    let requestUrl;
    globalThis.fetch = async (url) => {
      requestUrl = url;
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    const llm = openaiChat({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
    });
    await llm.chat('ping');
    assert.equal(requestUrl, 'https://example.test/v1/chat/completions');
  });

  it('custom model override', async () => {
    let payload;
    globalThis.fetch = async (_url, init) => {
      payload = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    const llm = openaiChat({
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
    });
    await llm.chat('ping');
    assert.equal(payload.model, 'gpt-4o-mini');
  });

  it('does not throw when apiKey is missing', () => {
    assert.doesNotThrow(() => openaiChat({}));
  });

  it('chat() returns model content', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: 'hello' } }] };
      },
    });
    const llm = openaiChat({ apiKey: 'test-key' });
    const out = await llm.chat('ping');
    assert.equal(out, 'hello');
  });

  it('chat() sends bearer auth header', async () => {
    let headers;
    globalThis.fetch = async (_url, init) => {
      headers = init.headers;
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    const llm = openaiChat({ apiKey: 'secret-key' });
    await llm.chat('ping');
    assert.equal(headers.Authorization, 'Bearer secret-key');
  });
});
