---
name: neolata-mem
description: Graph-native memory engine for AI agents — hybrid vector+keyword search, biological decay, Zettelkasten linking, conflict resolution. Zero infrastructure. npm install and go.
metadata:
  openclaw:
    requires:
      bins:
        - node
    optionalEnv:
      - OPENAI_API_KEY        # For OpenAI embeddings/extraction
      - NVIDIA_API_KEY        # For NVIDIA NIM embeddings
      - SUPABASE_URL          # For Supabase storage backend
      - SUPABASE_KEY          # Supabase anon key (preferred) or service key
    homepage: https://github.com/Jeremiaheth/neolata-mem
    repository: https://github.com/Jeremiaheth/neolata-mem
---

# neolata-mem — Agent Memory Engine

Graph-native memory for AI agents with hybrid search, biological decay, and zero infrastructure.

**npm package:** `@jeremiaheth/neolata-mem`
**Repository:** [github.com/Jeremiaheth/neolata-mem](https://github.com/Jeremiaheth/neolata-mem)
**License:** MIT | **Tests:** 144/144 passing | **Node:** ≥18

## When to Use This Skill

Use neolata-mem when you need:
- **Persistent memory across sessions** that survives context compaction
- **Semantic search** over stored facts, decisions, and findings
- **Memory decay** so stale information naturally fades
- **Multi-agent memory** with cross-agent search and graph linking
- **Conflict resolution** — detect and evolve contradictory memories

Do NOT use if:
- You only need OpenClaw's built-in `memorySearch` (keyword + vector on workspace files)
- You want cloud-hosted memory (use Mem0 instead)
- You need a full knowledge graph database (use Graphiti + Neo4j)

## Install

```bash
npm install @jeremiaheth/neolata-mem
```

No Docker. No Python. No Neo4j. No cloud API required.

> **Note:** This package has no install scripts (`preinstall`/`postinstall`) and zero runtime dependencies. Only `vitest` as a devDependency.

## Quick Start (Zero Config)

```javascript
import { createMemory } from '@jeremiaheth/neolata-mem';

const mem = createMemory();
await mem.store('agent-1', 'User prefers dark mode');
const results = await mem.search('agent-1', 'UI preferences');
```

Works immediately with local JSON storage and keyword search. No API keys needed.

## With Semantic Search

```javascript
const mem = createMemory({
  embeddings: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
  },
});

await mem.store('kuro', 'Found XSS in login form', { category: 'finding', importance: 0.9 });
const results = await mem.search('kuro', 'security vulnerabilities');
```

Supports **5+ embedding providers**: OpenAI, NVIDIA NIM, Ollama, Azure, Together, or any OpenAI-compatible endpoint.

## Key Features

### Hybrid Search (Vector + Keyword Fallback)
Uses semantic similarity when embeddings are configured; falls back to tokenized keyword matching when they're not:
```javascript
// With embeddings → vector cosine similarity search
// Without embeddings → normalized keyword matching (stop word removal, lowercase, dedup)
const results = await mem.search('agent', 'security vulnerabilities');
```

Keyword search uses an inverted token index for O(1) lookups. When >500 memories exist, vector search pre-filters candidates using token overlap before cosine similarity (candidate narrowing).

### Biological Decay
Memories fade over time unless reinforced. Old, unaccessed memories naturally lose relevance:
```javascript
await mem.decay();        // Run maintenance — archive/delete stale memories
await mem.reinforce(id);  // Boost a memory to resist decay
```

### Memory Graph (Zettelkasten Linking)
Every memory is automatically linked to related memories by semantic similarity:
```javascript
const links = await mem.links(memoryId);     // Direct connections
const path = await mem.path(idA, idB);       // Shortest path between memories
const clusters = await mem.clusters();        // Detect topic clusters
```

### Conflict Resolution
Detect contradictions before storing:
```javascript
const conflicts = await mem.detectConflicts('agent', 'Server uses port 443');
// Returns: { conflicts: [...], updates: [...], novel: true/false }

await mem.evolve('agent', 'Server now uses port 8080');
// Archives old fact, stores new one with link to predecessor
```

### Multi-Agent Support
```javascript
await mem.store('kuro', 'Vuln found in API gateway');
await mem.store('maki', 'API gateway deployed to prod');
const all = await mem.searchAll('API gateway');  // Cross-agent search
```

### Event Emitter
Hook into the memory lifecycle:
```javascript
mem.on('store', ({ agent, content, id }) => { /* ... */ });
mem.on('search', ({ agent, query, results }) => { /* ... */ });
mem.on('decay', ({ archived, deleted, dryRun }) => { /* counts, not arrays */ });
```

### Batch APIs
Amortize embedding calls and I/O with bulk operations:
```javascript
// Store many memories in one call (single embed batch + single persist)
const result = await mem.storeMany('agent', [
  { text: 'Fact one', category: 'fact', importance: 0.8 },
  { text: 'Fact two', tags: ['infra'] },
  'Plain string also works',
]);
// { total: 3, stored: 3, results: [{ id, links }, ...] }

// Search multiple queries in one call (single embed batch)
const results = await mem.searchMany('agent', ['query one', 'query two']);
// [{ query: 'query one', results: [...] }, { query: 'query two', results: [...] }]
```

Batch operations include:
- Atomic rollback on persist failure (memories, indexes, backlinks all reverted)
- Cross-linking within the same batch
- Configurable caps: `maxBatchSize` (default 1000), `maxQueryBatchSize` (default 100)

### Bulk Ingestion with Fact Extraction
Extract atomic facts from text using an LLM, then store each with A-MEM linking:
```javascript
const mem = createMemory({
  embeddings: { type: 'openai', apiKey: process.env.OPENAI_API_KEY },
  extraction: { type: 'llm', apiKey: process.env.OPENAI_API_KEY },
});

const result = await mem.ingest('agent', longText);
// { total: 12, stored: 10, results: [...] }
```

## CLI

```bash
npx neolata-mem store myagent "Important fact here"
npx neolata-mem search myagent "query"
npx neolata-mem decay --dry-run
npx neolata-mem health
npx neolata-mem clusters
```

## OpenClaw Integration

neolata-mem complements OpenClaw's built-in `memorySearch`:
- **memorySearch** = searches your workspace `.md` files (BM25 + vector)
- **neolata-mem** = structured memory store with graph, decay, evolution, multi-agent

Use both together: memorySearch for workspace file recall, neolata-mem for agent-managed knowledge.

### Recommended Setup

In your agent's daily cron or heartbeat:
```javascript
// Store important facts from today's session
await mem.store(agentId, 'Key decision: migrated to Postgres', {
  category: 'decision',
  importance: 0.8,
  tags: ['infrastructure'],
});

// Run decay maintenance
await mem.decay();
```

## Comparison

| Feature | neolata-mem | Mem0 | OpenClaw memorySearch |
|---------|:-----------:|:----:|:---------------------:|
| Local-first (data stays on machine) | ✅ (default) | ❌ | ✅ |
| Hybrid search (vector + keyword) | ✅ | ❌ | ✅ |
| Memory decay | ✅ | ❌ | ❌ |
| Memory graph / linking | ✅ | ❌ | ❌ |
| Conflict resolution | ✅ | Partial | ❌ |
| Multi-agent | ✅ | ✅ | Per-agent |
| Zero infrastructure | ✅ | ❌ | ✅ |
| Event emitter | ✅ | ❌ | ❌ |
| Batch APIs (storeMany/searchMany) | ✅ | ❌ | ❌ |
| npm package | ✅ | ✅ | Built-in |

## Security

neolata-mem includes hardening against common agent memory attack vectors:

- **Prompt injection mitigation**: XML-fenced user content in all LLM prompts + structural output validation
- **Input validation**: Agent names (alphanumeric, max 64), text length caps (10KB), bounded memory count (50K), batch size caps (1000 store / 100 query)
- **Batch atomicity**: `storeMany` rolls back all memories, indexes, and backlinks on persist failure
- **SSRF protection**: All provider URLs validated via `validateBaseUrl()` — blocks cloud metadata endpoints (`169.254.169.254`), private IP ranges, non-HTTP protocols
- **Supabase hardening**: UUID validation on query params, error text sanitized (strips tokens/keys), upsert-based save (crash-safe), 429 retry with backoff
- **Atomic writes**: Write-to-temp + rename prevents file corruption
- **Path traversal guards**: Storage directories and write-through paths validated with `resolve()` + prefix checks
- **Cryptographic IDs**: `crypto.randomUUID()` — no predictable memory references
- **Retry bounds**: Exponential backoff with max 3 retries on 429s
- **Error surfacing**: Failed conflict detection returns `{ error }` instead of silent fallthrough

**Supabase key guidance:** Prefer the anon key with Row Level Security (RLS) policies over the service role key. The service key bypasses RLS and grants full access to all stored memories. Only use it for admin/migration tasks.

See the [full security section](docs/guide.md#security) for details.

### Data Residency & External API Usage

**Local-only mode** (default): Memories are stored as JSON at `./neolata-mem-data/graph.json` (relative to CWD). No data leaves your machine. Keyword search works without any API keys.

**With embeddings/extraction/LLM**: When you configure an external provider (OpenAI, NIM, Ollama, etc.), your memory text is sent to that provider's API for embedding or extraction. This is opt-in — you must explicitly provide an API key and base URL.

| Mode | Data sent externally? | Storage location |
|------|:---------------------:|------------------|
| Default (no config) | ❌ No | `./neolata-mem-data/graph.json` |
| Ollama embeddings | ❌ No (local) | `./neolata-mem-data/graph.json` |
| OpenAI/NIM embeddings | ⚠️ Memory text → provider | `./neolata-mem-data/graph.json` |
| Supabase storage | ⚠️ All data → Supabase | Supabase PostgreSQL |
| LLM conflict resolution | ⚠️ Memory text → provider | Storage unchanged |

**To keep all data local**: Use Ollama for embeddings and JSON storage. No API keys needed for keyword-only search.

## Links

- **npm:** [@jeremiaheth/neolata-mem](https://www.npmjs.com/package/@jeremiaheth/neolata-mem)
- **GitHub:** [Jeremiaheth/neolata-mem](https://github.com/Jeremiaheth/neolata-mem)
- **Full docs:** See `docs/guide.md` in the package
