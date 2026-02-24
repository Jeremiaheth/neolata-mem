/**
 * neolata-mem — Graph-native memory engine for AI agents.
 *
 * @example
 * // Zero-config (local JSON, no embeddings, no LLM)
 * import { createMemory } from '@jeremiaheth/neolata-mem';
 * const mem = createMemory();
 * await mem.store('agent-1', 'User prefers dark mode');
 * const results = await mem.search('agent-1', 'UI preferences');
 *
 * @example
 * // With OpenAI embeddings + conflict resolution
 * import { createMemory } from '@jeremiaheth/neolata-mem';
 * const mem = createMemory({
 *   embeddings: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
 *   llm: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
 * });
 */

import { MemoryGraph } from './graph.mjs';
import { openaiEmbeddings, noopEmbeddings } from './embeddings.mjs';
import { jsonStorage, memoryStorage } from './storage.mjs';
import { supabaseStorage } from './supabase-storage.mjs';
import { llmExtraction, passthroughExtraction } from './extraction.mjs';
import { openaiChat, openclawChat } from './llm.mjs';

/**
 * Create a configured MemoryGraph instance.
 *
 * @param {object} [opts] - Configuration (all optional — zero-config by default)
 *
 * @param {object} [opts.storage] - Storage backend
 * @param {'json'|'memory'|'supabase'} [opts.storage.type='json']
 * @param {string} [opts.storage.dir] - Directory for JSON storage
 * @param {string} [opts.storage.url] - Supabase project URL (for type='supabase')
 * @param {string} [opts.storage.key] - Supabase API key (for type='supabase')
 * @param {string} [opts.storage.table] - Supabase table name (default: 'memories')
 * @param {string} [opts.storage.linksTable] - Supabase links table (default: 'memory_links')
 * @param {string} [opts.storage.archiveTable] - Supabase archive table (default: 'memories_archive')
 * @param {Function} [opts.storage.fetch] - Custom fetch for testing
 *
 * @param {object} [opts.embeddings] - Embedding provider
 * @param {'openai'|'noop'} [opts.embeddings.type='noop'] - Provider type
 * @param {string} [opts.embeddings.apiKey] - API key
 * @param {string} [opts.embeddings.model] - Model name
 * @param {string} [opts.embeddings.baseUrl] - API base URL
 * @param {object} [opts.embeddings.extraBody] - Extra body params
 *
 * @param {object} [opts.extraction] - Fact extraction provider
 * @param {'llm'|'passthrough'} [opts.extraction.type='passthrough']
 * @param {string} [opts.extraction.apiKey]
 * @param {string} [opts.extraction.model]
 * @param {string} [opts.extraction.baseUrl]
 *
 * @param {object} [opts.llm] - LLM for conflict resolution
 * @param {'openai'} [opts.llm.type='openai']
 * @param {string} [opts.llm.apiKey]
 * @param {string} [opts.llm.model]
 * @param {string} [opts.llm.baseUrl]
 *
 * @param {object} [opts.graph] - Graph behavior config
 * @param {number} [opts.graph.linkThreshold=0.5]
 * @param {number} [opts.graph.maxLinksPerMemory=5]
 * @param {number} [opts.graph.decayHalfLifeDays=30]
 * @param {number} [opts.graph.archiveThreshold=0.15]
 * @param {number} [opts.graph.deleteThreshold=0.05]
 *
 * @returns {MemoryGraph}
 */
export function createMemory(opts = {}) {
  // Storage
  let storage;
  const storageOpts = opts.storage || {};
  switch (storageOpts.type) {
    case 'memory':
      storage = memoryStorage();
      break;
    case 'supabase':
      storage = supabaseStorage({
        url: storageOpts.url,
        key: storageOpts.key,
        table: storageOpts.table,
        linksTable: storageOpts.linksTable,
        archiveTable: storageOpts.archiveTable,
        fetch: storageOpts.fetch,
      });
      break;
    case 'json':
    default:
      storage = jsonStorage({ dir: storageOpts.dir });
      break;
  }

  // Embeddings
  let embeddings;
  const embOpts = opts.embeddings || {};
  switch (embOpts.type) {
    case 'openai':
      embeddings = openaiEmbeddings({
        apiKey: embOpts.apiKey,
        model: embOpts.model || 'text-embedding-3-small',
        baseUrl: embOpts.baseUrl || 'https://api.openai.com/v1',
        extraBody: embOpts.extraBody || {},
        nimInputType: embOpts.nimInputType || false,
      });
      break;
    case 'noop':
    default:
      embeddings = noopEmbeddings();
      break;
  }

  // Extraction
  let extraction = null;
  const extOpts = opts.extraction || {};
  switch (extOpts.type) {
    case 'llm':
      extraction = llmExtraction({
        apiKey: extOpts.apiKey,
        model: extOpts.model,
        baseUrl: extOpts.baseUrl,
      });
      break;
    case 'passthrough':
      extraction = passthroughExtraction();
      break;
    default:
      extraction = null;
      break;
  }

  // LLM (for conflict resolution)
  let llm = null;
  const llmOpts = opts.llm || {};
  if (llmOpts.type === 'openai' && llmOpts.apiKey) {
    llm = openaiChat({
      apiKey: llmOpts.apiKey,
      model: llmOpts.model,
      baseUrl: llmOpts.baseUrl,
    });
  } else if (llmOpts.type === 'openclaw') {
    llm = openclawChat({
      model: llmOpts.model,
      port: llmOpts.port,
      token: llmOpts.token,
    });
  }

  return new MemoryGraph({
    storage,
    embeddings,
    extraction,
    llm,
    config: opts.graph || {},
  });
}

// Re-export everything for advanced usage
export { MemoryGraph, tokenize } from './graph.mjs';
export { openaiEmbeddings, noopEmbeddings, cosineSimilarity } from './embeddings.mjs';
export { jsonStorage, memoryStorage } from './storage.mjs';
export { supabaseStorage } from './supabase-storage.mjs';
export { markdownWritethrough, webhookWritethrough } from './writethrough.mjs';
export { llmExtraction, passthroughExtraction } from './extraction.mjs';
export { openaiChat, openclawChat } from './llm.mjs';
export { validateBaseUrl } from './validate.mjs';
