import { describe, it, expect } from 'vitest';
import { validateBaseUrl } from '../src/validate.mjs';
import { cosineSimilarity, openaiEmbeddings } from '../src/embeddings.mjs';
import { openclawChat } from '../src/llm.mjs';

describe('validateBaseUrl', () => {
  it('accepts valid HTTPS URLs', () => {
    expect(() => validateBaseUrl('https://api.openai.com/v1')).not.toThrow();
    expect(() => validateBaseUrl('https://integrate.api.nvidia.com/v1')).not.toThrow();
  });

  it('accepts localhost HTTP', () => {
    expect(() => validateBaseUrl('http://localhost:3577/v1')).not.toThrow();
    expect(() => validateBaseUrl('http://127.0.0.1:18789/v1')).not.toThrow();
  });

  it('rejects empty/non-string', () => {
    expect(() => validateBaseUrl('')).toThrow('non-empty string');
    expect(() => validateBaseUrl(null)).toThrow('non-empty string');
    expect(() => validateBaseUrl(123)).toThrow('non-empty string');
  });

  it('rejects non-HTTP protocols', () => {
    expect(() => validateBaseUrl('ftp://evil.com')).toThrow('http:// or https://');
    expect(() => validateBaseUrl('file:///etc/passwd')).toThrow('http:// or https://');
  });

  it('blocks private IP ranges by default', () => {
    expect(() => validateBaseUrl('http://10.0.0.1/api')).toThrow('private IP');
    expect(() => validateBaseUrl('http://172.16.0.1/api')).toThrow('private IP');
    expect(() => validateBaseUrl('http://192.168.1.1/api')).toThrow('private IP');
  });

  it('allows private IPs with allowPrivate flag', () => {
    expect(() => validateBaseUrl('http://10.0.0.1/api', { allowPrivate: true })).not.toThrow();
    expect(() => validateBaseUrl('http://192.168.1.1/api', { allowPrivate: true })).not.toThrow();
  });

  it('always blocks cloud metadata endpoints', () => {
    expect(() => validateBaseUrl('http://169.254.169.254/latest/meta-data', { allowPrivate: true }))
      .toThrow('cloud metadata');
    expect(() => validateBaseUrl('http://metadata.google.internal/v1'))
      .toThrow('cloud metadata');
  });

  it('blocks non-localhost HTTP with requireHttps', () => {
    expect(() => validateBaseUrl('http://evil.com/api', { requireHttps: true }))
      .toThrow('must use HTTPS');
    // localhost HTTP still allowed
    expect(() => validateBaseUrl('http://localhost:3000', { requireHttps: true })).not.toThrow();
  });
});

describe('cosineSimilarity dimension check', () => {
  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow('dimension mismatch');
  });

  it('works with matching dimensions', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1.0);
  });
});

describe('openclawChat port validation', () => {
  it('rejects invalid ports', () => {
    expect(() => openclawChat({ port: -1 })).toThrow('Invalid port');
    expect(() => openclawChat({ port: 70000 })).toThrow('Invalid port');
    expect(() => openclawChat({ port: 'abc' })).toThrow('Invalid port');
  });

  it('accepts valid ports', () => {
    expect(() => openclawChat({ port: 3577 })).not.toThrow();
    expect(() => openclawChat({ port: 18789 })).not.toThrow();
  });
});

describe('openaiEmbeddings URL validation', () => {
  it('rejects private IPs', () => {
    expect(() => openaiEmbeddings({
      apiKey: 'test', model: 'test',
      baseUrl: 'http://169.254.169.254/v1',
    })).toThrow('cloud metadata');
  });
});
