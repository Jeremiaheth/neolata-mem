/**
 * LLM provider for conflict resolution.
 * Must implement: chat(prompt) → string
 */

import { validateBaseUrl } from './validate.mjs';

// ─── OpenClaw Gateway Provider ──────────────────────────────
/**
 * Use OpenClaw's gateway as the LLM provider.
 * The gateway exposes an OpenAI-compatible API at localhost:3577.
 *
 * @param {object} [opts]
 * @param {string} [opts.model='haiku'] - Model alias or full provider/model
 * @param {number} [opts.port=3577] - Gateway port
 * @param {string} [opts.token] - Gateway token (reads OPENCLAW_GATEWAY_TOKEN env if not set)
 * @param {number} [opts.maxTokens=1000]
 * @param {number} [opts.temperature=0.1]
 */
export function openclawChat({ model = 'haiku', port = 3577, token, maxTokens = 1000, temperature = 0.1 } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Invalid port: ${port}`);
  const apiKey = token || process.env.OPENCLAW_GATEWAY_TOKEN || 'openclaw';
  return openaiChat({
    apiKey,
    model,
    baseUrl: `http://127.0.0.1:${p}/v1`,
    maxTokens,
    temperature,
  });
}

// ─── OpenAI-Compatible Chat Provider ────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.model='gpt-4.1-nano']
 * @param {string} [opts.baseUrl='https://api.openai.com/v1']
 * @param {number} [opts.maxTokens=1000]
 * @param {number} [opts.temperature=0.1]
 */
export function openaiChat({ apiKey, model = 'gpt-4.1-nano', baseUrl = 'https://api.openai.com/v1', maxTokens = 1000, temperature = 0.1 }) {
  validateBaseUrl(baseUrl, { label: 'llm baseUrl' });
  return {
    name: `openai-chat(${model})`,
    async chat(prompt) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature,
        }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    },
  };
}
