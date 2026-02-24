/**
 * Embedding provider interface and implementations.
 * All providers must implement: embed(texts) → number[][]
 * Optionally: embedQuery(text) → number[][] (for asymmetric models like NIM)
 */

import { validateBaseUrl } from './validate.mjs';

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── OpenAI-Compatible Provider ─────────────────────────────
/**
 * Works with OpenAI, NVIDIA NIM, Ollama, Azure, any OpenAI-compatible API.
 *
 * For NVIDIA NIM models that use asymmetric embeddings (e.g. `baai/bge-m3`,
 * `nvidia/nv-embedqa-e5-v5`), set `nimInputType: true`. This will automatically
 * send `input_type: 'passage'` when storing and `input_type: 'query'` when searching.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model - e.g. 'text-embedding-3-small', 'baai/bge-m3'
 * @param {string} [opts.baseUrl='https://api.openai.com/v1'] - API base URL
 * @param {object} [opts.extraBody={}] - Extra body params merged into every request
 * @param {boolean} [opts.nimInputType=false] - Auto-set input_type for NIM asymmetric models
 * @param {number} [opts.retryMs=2000] - Base retry delay on 429
 * @param {number} [opts.maxRetries=3] - Max retries on 429
 */
export function openaiEmbeddings({
  apiKey, model, baseUrl = 'https://api.openai.com/v1',
  extraBody = {}, nimInputType = false,
  retryMs = 2000, maxRetries = 3,
}) {
  validateBaseUrl(baseUrl, { label: 'embeddings baseUrl' });

  async function _embed(texts, overrides = {}, _retryCount = 0) {
    const input = Array.isArray(texts) ? texts : [texts];
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, ...extraBody, ...overrides }),
    });
    if (res.status === 429) {
      if (_retryCount >= maxRetries) throw new Error(`Embedding rate-limited after ${maxRetries} retries`);
      const backoff = retryMs * Math.pow(2, _retryCount);
      await new Promise(r => setTimeout(r, backoff));
      return _embed(texts, overrides, _retryCount + 1);
    }
    if (!res.ok) throw new Error(`Embedding ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.map(d => d.embedding);
  }

  return {
    name: `openai-compatible(${model})`,
    model,

    /**
     * Embed texts for storage/indexing.
     * For NIM: sends input_type='passage' when nimInputType is true.
     */
    async embed(texts) {
      const overrides = nimInputType ? { input_type: 'passage' } : {};
      return _embed(texts, overrides);
    },

    /**
     * Embed a query for search/retrieval.
     * For NIM: sends input_type='query' when nimInputType is true.
     * For non-NIM providers: identical to embed().
     */
    async embedQuery(text) {
      const overrides = nimInputType ? { input_type: 'query' } : {};
      return _embed(text, overrides);
    },
  };
}

// ─── Noop Provider (keyword-only mode) ──────────────────────
/**
 * No-op embedding provider. Returns null embeddings.
 * Use this when you don't want/need vector search — keyword matching still works.
 */
export function noopEmbeddings() {
  return {
    name: 'noop',
    model: null,
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      return input.map(() => null);
    },
    async embedQuery(text) {
      return [null];
    },
  };
}
