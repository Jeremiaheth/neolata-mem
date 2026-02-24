# neolata-mem

**Graph-native memory engine for AI agents.** Zettelkasten-inspired linking, biological decay, conflict resolution.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

---

No Python. No Docker. No Neo4j. Just `npm install`.

```bash
npm install @jeremiaheth/neolata-mem
```

## Quick Start (3 lines)

```javascript
import { createMemory } from '@jeremiaheth/neolata-mem';

const mem = createMemory();
await mem.store('agent-1', 'User prefers dark mode');
const results = await mem.search('agent-1', 'UI preferences');
// [{ memory: 'User prefers dark mode', score: 1.0, ... }]
```

That's it. Zero config. Local JSON storage, keyword search, no API keys needed.

## With Embeddings (Semantic Search)

```javascript
const mem = createMemory({
  embeddings: {
    type: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
  },
});

await mem.store('kuro', 'Found XSS vulnerability in login form', { category: 'finding', importance: 0.9 });
await mem.store('kuro', 'OWASP Top 10 audit completed', { category: 'event' });

const results = await mem.search('kuro', 'security vulnerabilities');
// Ranked by semantic similarity
```

Works with any OpenAI-compatible API: **OpenAI, NVIDIA NIM, Ollama, Azure, Groq, Together, etc.**

```javascript
// NVIDIA NIM (free tier)
embeddings: {
  type: 'openai',
  apiKey: process.env.NVIDIA_API_KEY,
  model: 'baai/bge-m3',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
}

// Local Ollama
embeddings: {
  type: 'openai',
  apiKey: 'ollama',
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:11434/v1',
}
```

## Core Concepts

### 🔗 A-MEM Zettelkasten Linking

Every memory automatically links to related memories — bidirectionally. When you store "Redis runs on port 6379", it finds existing memories about Redis, ports, or databases and creates links in both directions.

```javascript
await mem.store('a', 'Redis runs on port 6379');
await mem.store('a', 'We use Redis for session caching');  // Auto-links to first memory

const links = await mem.links(memoryId);
// { memory: 'Redis runs on port 6379', links: [{ memory: 'We use Redis for session caching', similarity: 0.87 }] }
```

### 🧬 Biological Decay

Memories have a **strength** that decays over time, just like biological memory:

- **Half-life**: 30 days (configurable)
- **Link reinforcement**: More connections = slower decay (+5% per link, max +30%)
- **Category stickiness**: Preferences (1.4×), decisions (1.3×), and insights (1.1×) resist decay
- **Access boost**: Each reinforcement adds +2% importance

```javascript
const report = await mem.decay({ dryRun: true });  // Preview what would be pruned
// { total: 100, healthy: 85, weakening: 10, archived: [...], deleted: [...] }

await mem.decay();  // Archive weak memories, delete dead ones
```

### ⚔️ Conflict Resolution

Detects contradictions and evolves memories over time (requires LLM):

```javascript
const mem = createMemory({
  embeddings: { type: 'openai', apiKey: KEY },
  llm: { type: 'openai', apiKey: KEY, model: 'gpt-4.1-nano' },
});

await mem.store('a', 'Server runs on port 3000');
await mem.evolve('a', 'Server now runs on port 8080');
// EVOLVED: "Server runs on port 3000" → "Server now runs on port 8080"
// Old version archived with evolution history
```

### 🌐 Multi-Agent

Native support for multiple agents with cross-agent search:

```javascript
await mem.store('kuro', 'Found SQL injection in /api/users');
await mem.store('maki', 'Deployed fix for /api/users endpoint');

const results = await mem.searchAll('api users security');
// Returns memories from both agents, ranked by relevance
```

## Graph Queries

```javascript
// Multi-hop traversal
const graph = await mem.traverse(memoryId, 3);  // Walk 3 hops from a memory

// Find memory clusters
const clusters = await mem.clusters(3);  // Connected components with 3+ members

// Shortest path between memories
const path = await mem.path(idA, idB);

// Find disconnected memories
const orphans = await mem.orphans('kuro');

// Health report
const health = await mem.health();
// { total, byAgent, byCategory, avgStrength, distribution, orphans, ... }

// Timeline view
const timeline = await mem.timeline('kuro', 7);  // Last 7 days

// Context generation (for RAG / prompt injection)
const ctx = await mem.context('kuro', 'database security');
// Returns formatted briefing with 1-hop expansion from top results
```

## Configuration

```javascript
const mem = createMemory({
  // Storage backend
  storage: {
    type: 'json',         // 'json' (default) | 'memory' (ephemeral)
    dir: './my-data',     // Custom directory for JSON storage
  },

  // Embeddings (optional — keyword search works without)
  embeddings: {
    type: 'openai',       // 'openai' (any compatible API) | 'noop' (keyword only)
    apiKey: '...',
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    extraBody: {},        // Extra params (e.g. { input_type: 'passage' } for NIM)
  },

  // Fact extraction (optional — enables ingest())
  extraction: {
    type: 'llm',          // 'llm' | 'passthrough'
    apiKey: '...',
    model: 'gpt-4.1-nano',
    baseUrl: 'https://api.openai.com/v1',
  },

  // LLM for conflict resolution (optional — enables evolve())
  llm: {
    type: 'openai',
    apiKey: '...',
    model: 'gpt-4.1-nano',
    baseUrl: 'https://api.openai.com/v1',
  },

  // Graph behavior
  graph: {
    linkThreshold: 0.5,        // Min similarity for auto-linking (0-1)
    maxLinksPerMemory: 5,      // Max auto-links per new memory
    decayHalfLifeDays: 30,     // Decay half-life
    archiveThreshold: 0.15,    // Archive below this strength
    deleteThreshold: 0.05,     // Delete below this strength
    maxMemories: 50000,        // Max total memories (prevents unbounded growth)
    maxMemoryLength: 10000,    // Max characters per memory text
    maxAgentLength: 64,        // Max agent name length
    evolveMinIntervalMs: 1000, // Rate limit between evolve() calls (ms)
  },
});
```

## CLI

```bash
npx @jeremiaheth/neolata-mem store agent-1 "User prefers dark mode"
npx @jeremiaheth/neolata-mem search agent-1 "UI preferences"
npx @jeremiaheth/neolata-mem health
npx @jeremiaheth/neolata-mem decay --dry-run
```

Set `OPENAI_API_KEY` or `NVIDIA_API_KEY` for embedding support. See `npx @jeremiaheth/neolata-mem` for all commands.

## API Reference

### `createMemory(opts?) → MemoryGraph`

Factory function. All options are optional — zero-config returns a working instance with JSON storage and keyword search.

### Core Methods

| Method | Description |
|--------|-------------|
| `store(agent, text, opts?)` | Store with A-MEM auto-linking |
| `search(agent, query, opts?)` | Semantic/keyword search (single agent) |
| `searchAll(query, opts?)` | Cross-agent search |
| `evolve(agent, text, opts?)` | Store with conflict resolution |
| `ingest(agent, text, opts?)` | Bulk extract facts and store |
| `context(agent, query, opts?)` | Generate context briefing |

### Graph Methods

| Method | Description |
|--------|-------------|
| `links(memoryId)` | Get memory and its connections |
| `traverse(startId, hops?)` | Multi-hop BFS walk |
| `clusters(minSize?)` | Find connected components |
| `path(idA, idB)` | Shortest path between memories |
| `orphans(agent?, maxLinks?)` | Find disconnected memories |

### Lifecycle Methods

| Method | Description |
|--------|-------------|
| `decay(opts?)` | Run decay cycle (archive/delete weak memories) |
| `reinforce(memoryId, boost?)` | Boost memory importance |
| `health()` | Full health report |
| `timeline(agent?, days?)` | Date-grouped memory view |

### Advanced: Bring Your Own Providers

```javascript
import { MemoryGraph } from '@jeremiaheth/neolata-mem';

const graph = new MemoryGraph({
  storage: myCustomStorage,      // { load, save, loadArchive, saveArchive, genId }
  embeddings: myCustomEmbedder,  // { embed(texts) → number[][] }
  extraction: myExtractor,       // { extract(text) → Fact[] }
  llm: myLLM,                   // { chat(prompt) → string }
  config: { ... },
});
```

## How It Works

```
Text → [Embed] → [Find Related] → [Link Bidirectionally] → [Store]
                       ↑
                 Existing memories
                 with embeddings

Conflict Detection:
  New fact → [Embed] → [Find high-similarity] → [LLM: conflict/update/novel?]
    → CONFLICT: archive old, store new
    → UPDATE: modify existing in-place (with evolution history)
    → NOVEL: normal A-MEM store

Decay Cycle:
  For each memory:
    strength = (importance × ageFactor × touchFactor × categoryWeight) + linkBonus + accessBonus
    if strength < 0.05: delete
    if strength < 0.15: archive
    Clean up broken links
```

## Comparison

| Feature | neolata-mem | Mem0 | Letta | Zep |
|---------|------------|------|-------|-----|
| Zettelkasten linking | ✅ | ❌ | ❌ | ❌ |
| Biological decay | ✅ | ❌ | ❌ | ❌ |
| Graph traversal | ✅ | ❌ | ❌ | ✅ |
| Multi-agent native | ✅ | ❌ | ❌ | ❌ |
| Conflict resolution | ✅ | ✅ | ❌ | ❌ |
| Works offline | ✅ | ✅ | ✅ | ❌ |
| No Python needed | ✅ | ❌ | ❌ | ❌ |
| Zero-config start | ✅ | ❌ | ❌ | ❌ |
| LLM optional | ✅ | ❌ | ❌ | ❌ |

## Security

neolata-mem includes several hardening measures:

- **Input validation**: Agent names (alphanumeric, max 64 chars), memory text (max 10KB), bounded total memory count (default 50K)
- **Prompt injection mitigation**: All user content is XML-fenced in LLM prompts with explicit instruction boundaries. LLM output is structurally validated (type checks, index bounds, category whitelists)
- **SSRF protection**: All provider URLs validated via `validateBaseUrl()` — blocks cloud metadata endpoints, private IP ranges (configurable), non-HTTP protocols
- **Supabase hardening**: UUID validation on all query params (prevents PostgREST injection), error text sanitized (strips tokens/keys), safe upsert-based save (no data loss on crash), automatic 429 retry with backoff
- **Atomic writes**: JSON storage uses write-to-temp + rename to prevent corruption from concurrent access
- **Path traversal guards**: Storage directories and write-through paths validated with `resolve()` + prefix checks
- **Cryptographic IDs**: Memory IDs use `crypto.randomUUID()` (not `Math.random`)
- **Retry bounds**: Embedding and Supabase API retries are capped at 3 with exponential backoff (no infinite loops)
- **Error surfacing**: Failed conflict detection returns `{ error }` instead of silently proceeding

**Trust model**: For JSON storage, neolata-mem trusts the filesystem — protect your data directory. For Supabase, use Row Level Security (RLS) policies. Embedding vectors can approximate original text via inversion attacks — treat them as sensitive.

## Documentation

📖 **[Full User Guide](docs/guide.md)** — configuration deep dive, embedding providers, storage backends, recipes, troubleshooting, architecture.

## License

MIT — do whatever you want.
