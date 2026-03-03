import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      // node:test-based files (run via: node --test --test-isolation=none test/{cli,embeddings,extraction,llm,integration,storage}.test.mjs)
      'test/cli.test.mjs',
      'test/embeddings.test.mjs',
      'test/extraction.test.mjs',
      'test/llm.test.mjs',
      'test/integration.test.mjs',
      'test/storage.test.mjs',
      // vitest defaults
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
