/**
 * Embedding provider interface and implementations.
 * All providers must implement: embed(texts) → number[][]
 */

/**
 * Cosine similarity between two vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
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
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model - e.g. 'text-embedding-3-small', 'baai/bge-m3'
 * @param {string} [opts.baseUrl='https://api.openai.com/v1'] - API base URL
 * @param {object} [opts.extraBody] - Extra body params (e.g. { input_type: 'passage' })
 * @param {number} [opts.retryMs=2000] - Retry delay on 429
 */
export function openaiEmbeddings({ apiKey, model, baseUrl = 'https://api.openai.com/v1', extraBody = {}, retryMs = 2000, maxRetries = 3 }) {
  return {
    name: `openai-compatible(${model})`,
    model,
    async embed(texts, _retryCount = 0) {
      const input = Array.isArray(texts) ? texts : [texts];
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input, ...extraBody }),
      });
      if (res.status === 429) {
        if (_retryCount >= maxRetries) throw new Error(`Embedding rate-limited after ${maxRetries} retries`);
        const backoff = retryMs * Math.pow(2, _retryCount);
        await new Promise(r => setTimeout(r, backoff));
        return this.embed(texts, _retryCount + 1);
      }
      if (!res.ok) throw new Error(`Embedding ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.data.map(d => d.embedding);
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
  };
}
