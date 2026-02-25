# neolata-mem

**Graph-native memory engine for AI agents.** Zettelkasten-inspired linking, biological decay, conflict resolution.

[![Elastic License 2.0](https://img.shields.io/badge/license-Elastic--2.0-blue.svg)](LICENSE)
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

Every memory automatically links to related memories - bidirectionally. When you store "Redis runs on port 6379", it finds existing memories about Redis, ports, or databases and creates links in both directions.

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

### ⚔️ Conflict Resolution & Quarantine

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

**Quarantine lane** - low-trust or structurally conflicting memories are quarantined instead of auto-superseding:

```javascript
// Store with claim metadata and provenance
await mem.store('a', 'Server runs on port 443', {
  claim: { subject: 'server', predicate: 'port', value: '443' },
  provenance: { source: 'user_explicit', trust: 1.0 },
  onConflict: 'quarantine',  // default - quarantine low-trust conflicts
});

// Review quarantined memories
const quarantined = await mem.listQuarantined();
await mem.reviewQuarantine(quarantined[0].id, { action: 'activate' });
// or: { action: 'reject' } to archive it
```

### 📋 Predicate Schema Registry

Define rules for how predicates handle conflicts, deduplication, and normalization:

```javascript
const mem = createMemory({
  predicateSchemas: {
    'preferred_language': { cardinality: 'single', conflictPolicy: 'supersede', normalize: 'lowercase_trim' },
    'spoken_languages':   { cardinality: 'multi', dedupPolicy: 'corroborate' },
    'salary':             { cardinality: 'single', conflictPolicy: 'require_review', normalize: 'currency' },
  },
});

mem.registerPredicate('timezone', { cardinality: 'single', normalize: 'trim' });
```

### 🔍 Explainability API

Understand why memories were returned, filtered, or superseded:

```javascript
const results = await mem.search('kuro', 'port config', { explain: true });
console.log(results.meta);        // { query, options, resultCount, ... }
console.log(results[0].explain);  // { retrieved, rerank, statusFilter, ... }

const detail = await mem.explainMemory(memoryId);
// { id, status, trust, confidence, provenance, claimSummary }

const chain = await mem.explainSupersession(memoryId);
// { superseded, supersededBy, trustComparison: { original, superseding, delta } }
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

  // Embeddings (optional - keyword search works without)
  embeddings: {
    type: 'openai',       // 'openai' (any compatible API) | 'noop' (keyword only)
    apiKey: '...',
    model: 'text-embedding-3-small',
    baseUrl: 'https://api.openai.com/v1',
    extraBody: {},        // Extra params (e.g. { input_type: 'passage' } for NIM)
  },

  // Fact extraction (optional - enables ingest())
  extraction: {
    type: 'llm',          // 'llm' | 'passthrough'
    apiKey: '...',
    model: 'gpt-4.1-nano',
    baseUrl: 'https://api.openai.com/v1',
  },

  // LLM for conflict resolution (optional - enables evolve())
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

### Episodes (Temporal Grouping)
Group related memories into named episodes with time ranges:
```javascript
// Manual: group specific memories
const ep = await mem.createEpisode('Deploy v2.0', [id1, id2, id3], { tags: ['deploy'] });

// Auto-capture: grab all memories in a time window
const ep2 = await mem.captureEpisode('kuro', 'Morning standup', {
  start: '2026-02-25T09:00:00Z',
  end: '2026-02-25T10:00:00Z',
});

// Search within an episode
const results = await mem.searchEpisode(ep.id, 'database migration');

// LLM-generated summary
const { summary } = await mem.summarizeEpisode(ep.id);
```

### Memory Compression
Consolidate redundant memories into digests (extractive or LLM-based):
```javascript
// Compress specific memories
const digest = await mem.compress([id1, id2, id3], {
  method: 'llm',             // 'extractive' (default) or 'llm'
  archiveOriginals: true,     // archive source memories after compression
});

// Compress an episode or cluster
await mem.compressEpisode(episodeId);
await mem.compressCluster(0);  // by cluster index from clusters()

// Auto-compress stale clusters
const result = await mem.autoCompress({ minClusterSize: 3, maxDigests: 5 });
// { compressed: 3, totalSourceMemories: 15, digests: [...] }
```

### Labeled Clusters
Organize memories into persistent named groups:
```javascript
const cl = await mem.createCluster('Security findings', [id1, id2]);
await mem.refreshCluster(cl.id);    // Re-expand via BFS traversal
await mem.autoLabelClusters();       // LLM labels unlabeled clusters
```

### Consolidation (Full Maintenance)
Single call that runs the complete memory maintenance lifecycle:
```javascript
const report = await mem.consolidate({
  dedupThreshold: 0.95,       // Similarity threshold for dedup
  compressAge: 30,            // Compress clusters older than N days
  pruneSuperseded: true,      // Archive old superseded memories
  pruneQuarantined: false,    // Archive old unreviewed quarantined memories
  pruneAge: 90,               // Archive superseded older than N days
  dryRun: false,              // Preview without changes
});
// report: { deduplicated, contradictions, corroborated, compressed, pruned, before, after, duration_ms }
```

Phases: dedup → contradiction resolution → cross-source corroboration → compress stale clusters → prune.

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

Factory function. All options are optional - zero-config returns a working instance with JSON storage and keyword search.

### Core Methods

| Method | Description |
|--------|-------------|
| `store(agent, text, opts?)` | Store with A-MEM auto-linking. Opts: `claim`, `provenance`, `onConflict` |
| `search(agent, query, opts?)` | Semantic/keyword search. Opts: `explain`, `statusFilter`, `sessionId` |
| `searchAll(query, opts?)` | Cross-agent search |
| `evolve(agent, text, opts?)` | Store with conflict resolution |
| `ingest(agent, text, opts?)` | Bulk extract facts and store |
| `context(agent, query, opts?)` | Generate context briefing |
| `storeMany(agent, items, opts?)` | Batch store with atomic rollback |
| `searchMany(agent, queries, opts?)` | Batch search (single embed call) |

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
| `consolidate(opts?)` | Full maintenance: dedup → contradiction check → corroborate → compress → prune |

### Episode Methods

| Method | Description |
|--------|-------------|
| `createEpisode(name, ids, opts?)` | Group memories into a named episode |
| `captureEpisode(agent, name, opts)` | Auto-capture episode from time window |
| `getEpisode(id)` | Get episode with resolved memories |
| `addToEpisode(id, memoryIds)` | Add memories to an episode |
| `removeFromEpisode(id, memoryIds)` | Remove memories from an episode |
| `listEpisodes(opts?)` | List episodes (filter by agent, tag, time) |
| `searchEpisode(id, query, opts?)` | Semantic search within an episode |
| `summarizeEpisode(id)` | LLM-generated episode summary |
| `deleteEpisode(id)` | Delete episode (memories preserved) |

### Compression Methods

| Method | Description |
|--------|-------------|
| `compress(ids, opts?)` | Compress memories into a digest (extractive or LLM) |
| `compressEpisode(id, opts?)` | Compress all memories in an episode |
| `compressCluster(index, opts?)` | Compress an auto-detected cluster |
| `autoCompress(opts?)` | Auto-detect and compress stale clusters |

### Labeled Cluster Methods

| Method | Description |
|--------|-------------|
| `createCluster(label, ids, opts?)` | Create a named cluster |
| `labelCluster(index, label, opts?)` | Label an auto-detected cluster |
| `listClusters()` | List all labeled clusters |
| `getCluster(id)` | Get cluster with resolved memories |
| `refreshCluster(id)` | Re-expand cluster via BFS |
| `deleteCluster(id)` | Delete cluster (memories preserved) |
| `autoLabelClusters(opts?)` | LLM-generated labels for unlabeled clusters |

### Predicate Schema Methods

| Method | Description |
|--------|-------------|
| `registerPredicate(name, schema)` | Register conflict/normalization rules for a predicate |
| `registerPredicates(map)` | Bulk register from object or Map |
| `getPredicateSchema(name)` | Get effective schema (with defaults) |
| `listPredicateSchemas()` | List all registered schemas |

### Explainability Methods

| Method | Description |
|--------|-------------|
| `explainMemory(memoryId)` | Trust, confidence, provenance, claim summary |
| `explainSupersession(memoryId)` | Supersession chain with trust comparison |

### Quarantine Methods

| Method | Description |
|--------|-------------|
| `quarantine(memoryId, opts?)` | Manually quarantine an active memory |
| `listQuarantined(opts?)` | List quarantined memories (filterable by agent) |
| `reviewQuarantine(memoryId, opts)` | Activate or reject a quarantined memory |
| `pendingConflicts()` | List unresolved structural conflicts |
| `resolveConflict(conflictId, opts)` | Resolve a pending conflict |

### Advanced: Bring Your Own Providers

```javascript
import { MemoryGraph } from '@jeremiaheth/neolata-mem';

const graph = new MemoryGraph({
  storage: myCustomStorage,      // { load, save, loadArchive, saveArchive, genId,
                                 //   loadEpisodes?, saveEpisodes?, genEpisodeId?,
                                 //   loadClusters?, saveClusters?, genClusterId?,
                                 //   loadPendingConflicts?, savePendingConflicts? }
  embeddings: myCustomEmbedder,  // { embed(texts) → number[][] }
  extraction: myExtractor,       // { extract(text) → Fact[] }
  llm: myLLM,                   // { chat(prompt) → string }
  config: { ... },
});
```

## How It Works

```
Text → [Embed] → [Find Related] → [Link Bidirectionally] → [Store]
                       ↑                      ↓
                 Existing memories    [Structural Conflict Check]
                 with embeddings       (claim matching by subject/predicate)
                                             ↓
                                  [Trust Comparison] → quarantine or supersede

Conflict Detection (evolve):
  New fact → [Embed] → [Find high-similarity] → [LLM: conflict/update/novel?]
    → CONFLICT: archive old, store new
    → UPDATE: modify existing in-place (with evolution history)
    → NOVEL: normal A-MEM store

Structural Conflict Detection (store with claims):
  New claim → [Match subject+predicate+scope] → [Compare trust scores]
    → Higher trust: supersede existing
    → Lower trust: quarantine new (or keep_active via onConflict option)
    → Equal trust or require_review policy: add to pending conflicts

Trust Score:
  trust = sourceWeight + corroborationBonus + feedbackSignal - recencyPenalty
  Sources: user_explicit(1.0), system(0.95), tool_output(0.85),
           user_implicit(0.7), document(0.6), inference(0.5)

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
| Quarantine lane | ✅ | ❌ | ❌ | ❌ |
| Predicate schemas | ✅ | ❌ | ❌ | ❌ |
| Explainability API | ✅ | ❌ | ❌ | ❌ |
| Episodes & compression | ✅ | ❌ | ❌ | ❌ |
| Labeled clusters | ✅ | ❌ | ❌ | ❌ |
| Works offline | ✅ | ✅ | ✅ | ❌ |
| No Python needed | ✅ | ❌ | ❌ | ❌ |
| Zero-config start | ✅ | ❌ | ❌ | ❌ |
| LLM optional | ✅ | ❌ | ❌ | ❌ |

## Security

neolata-mem includes several hardening measures:

- **Input validation**: Agent names (alphanumeric, max 64 chars), memory text (max 10KB), bounded total memory count (default 50K)
- **Prompt injection mitigation**: All user content is XML-fenced in LLM prompts with explicit instruction boundaries. LLM output is structurally validated (type checks, index bounds, category whitelists)
- **SSRF protection**: All provider URLs validated via `validateBaseUrl()` - blocks cloud metadata endpoints, private IP ranges (configurable), non-HTTP protocols
- **Supabase hardening**: UUID validation on all query params (prevents PostgREST injection), error text sanitized (strips tokens/keys), safe upsert-based save (no data loss on crash), automatic 429 retry with backoff
- **Atomic writes**: JSON storage uses write-to-temp + rename to prevent corruption from concurrent access
- **Path traversal guards**: Storage directories and write-through paths validated with `resolve()` + prefix checks
- **Cryptographic IDs**: Memory IDs use `crypto.randomUUID()` (not `Math.random`)
- **Retry bounds**: Embedding and Supabase API retries are capped at 3 with exponential backoff (no infinite loops)
- **Error surfacing**: Failed conflict detection returns `{ error }` instead of silently proceeding

**Trust model**: For JSON storage, neolata-mem trusts the filesystem - protect your data directory. For Supabase, use Row Level Security (RLS) policies. Embedding vectors can approximate original text via inversion attacks - treat them as sensitive.

## Documentation

📖 **[Full User Guide](docs/guide.md)** - configuration deep dive, embedding providers, storage backends, recipes, troubleshooting, architecture.

## License

[Elastic License 2.0](LICENSE) — free to use, modify, and distribute. You just can't offer it as a hosted/managed service.
