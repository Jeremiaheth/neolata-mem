/**
 * LLM provider for conflict resolution.
 * Must implement: chat(prompt) → string
 */

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
