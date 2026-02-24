---
name: neolata-mem
description: Graph-native memory engine for AI agents — hybrid vector+keyword search, biological decay, Zettelkasten linking, conflict resolution. Zero infrastructure. npm install and go.
metadata:
  openclaw:
    requires:
      bins:
        - node
    optionalEnv:
      - OPENAI_API_KEY  # Only needed for semantic/embedding search mode
    homepage: https://github.com/Jeremiaheth/neolata-mem
    repository: https://github.com/Jeremiaheth/neolata-mem
---

# neolata-mem — Agent Memory Engine

Graph-native memory for AI agents with hybrid search, biological decay, and zero infrastructure.

**npm package:** `@jeremiaheth/neolata-mem`
**Repository:** [github.com/Jeremiaheth/neolata-mem](https://github.com/Jeremiaheth/neolata-mem)
**License:** MIT | **Tests:** 38/38 passing | **Node:** ≥18

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
Uses semantic similarity when embeddings are configured; falls back to substring keyword matching when they're not:
```javascript
// With embeddings → vector cosine similarity search
// Without embeddings → case-insensitive keyword matching
const results = await mem.search('agent', 'security vulnerabilities');
```

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
| Local-first (data stays on machine) | ✅ | ❌ | ✅ |
| Hybrid search (vector + keyword) | ✅ | ❌ | ✅ |
| Memory decay | ✅ | ❌ | ❌ |
| Memory graph / linking | ✅ | ❌ | ❌ |
| Conflict resolution | ✅ | Partial | ❌ |
| Multi-agent | ✅ | ✅ | Per-agent |
| Zero infrastructure | ✅ | ❌ | ✅ |
| Event emitter | ✅ | ❌ | ❌ |
| npm package | ✅ | ✅ | Built-in |

## Security

neolata-mem includes hardening against common agent memory attack vectors:

- **Prompt injection mitigation**: XML-fenced user content in all LLM prompts + structural output validation
- **Input validation**: Agent names (alphanumeric, max 64), text length caps (10KB), bounded memory count (50K)
- **Atomic writes**: Write-to-temp + rename prevents file corruption
- **Cryptographic IDs**: `crypto.randomUUID()` — no predictable memory references
- **Retry bounds**: Exponential backoff with max 3 retries on 429s
- **Error surfacing**: Failed conflict detection returns `{ error }` instead of silent fallthrough

See the [full security section](docs/guide.md#security) for details.

## Links

- **npm:** [@jeremiaheth/neolata-mem](https://www.npmjs.com/package/@jeremiaheth/neolata-mem)
- **GitHub:** [Jeremiaheth/neolata-mem](https://github.com/Jeremiaheth/neolata-mem)
- **Full docs:** See `docs/guide.md` in the package
