# neolata-mem v0.8.1 Addendum: Repo Audit, Deterministic Semantics, and Implementation Blueprint

## Executive summary

The repository at `Jeremiaheth/neolata-mem` is already **at v0.8.1** (per `package.json`) and contains substantial implementations of the addendum’s core “memory intelligence” primitives—especially around **structured claims, predicate-level conflict policy, trust/confidence, quarantine gating, explainable retrieval, budget-aware context packing, and an automated consolidation lifecycle**. citeturn6view0turn14view0turn20view0turn45view0turn7view2

Concretely, the codebase already supports: **(a)** a predicate schema registry (in-memory map) with `cardinality`, `conflictPolicy`, and normalisation modes (e.g., currency); **(b)** deterministic structural contradiction checks on `claim` keyed by `(subject,predicate)` with validity-window overlap and session scoping; **(c)** trust-gated supersession plus quarantine + pending-conflict creation; **(d)** retrieval explainability (`search(...,{explain:true})` attaches per-result “retrieved” and “rerank” breakdown plus overall `meta`), plus `explainMemory()` and `explainSupersession()`; **(e)** reranking via a multi-signal composite (relevance, confidence, recency, importance); and **(f)** an opinionated `consolidate()` pipeline (dedupe → contradiction pass → corroboration → compress stale clusters → prune). citeturn6view1turn20view0turn14view0turn15view2turn7view2turn45view0

Where the repo is *not yet best-in-class*, relative to your requested **v0.8.1 addendum workflows**, is primarily in **agent-runtime orchestration** rather than the core memory graph:

- The “three workflows” you added—**heartbeat auto-store**, **contextual recall by topic**, and **pre-compaction structured dump**—do not appear as first-class APIs in the library (no `heartbeat` entrypoint exists in `graph.mjs`, and no “dump/compaction” hook is present). citeturn19view2turn19view4  
- Some “review lane” ergonomics (e.g., explicit `listQuarantined()` / `reviewQuarantine()` convenience APIs) are advertised in README-style positioning, but are not clearly evidenced as exported methods in the excerpts verified here; the underlying **data structures are present** (`status='quarantined'`, `quarantine` JSON, and `pending_conflicts` persistence), so completing this is tractable. citeturn20view0turn18view2turn10view1turn21view1

From a research alignment perspective, neolata-mem’s direction fits what the latest literature and vendor systems are emphasising: evaluation and design must cover retrieval accuracy and *selective forgetting/conflict resolution* (MemoryAgentBench), manage drift and noisy recall over long horizons (ACC), and harden against persistent compromise via memory/RAG poisoning (PoisonedRAG / AgentPoison / MemoryGraft). citeturn33view0turn34view1turn35view0turn31search1turn31search6turn31search3

## Repo audit

### Repo audit table

| File / path | Present? | Notes / relevance to v0.8.1 addendum |
|---|---:|---|
| `package.json` | Yes | Version is `0.8.1`; exports include `graph`, `storage`, `supabase-storage`, `extraction`, `llm`. citeturn6view0 |
| `README.md` | Yes | Documents “predicate schema registry”, “quarantine lane”, “explainability API”, “consolidate()”, and `context(...,{maxTokens})`. Treat as product surface; verify against code for truth. citeturn5view0 |
| `src/index.mjs` | Yes | `createMemory(opts)` wires storage/embeddings/extraction/llm; supports `predicateSchemas` config passthrough and re-exports core helpers. citeturn27view1 |
| `src/graph.mjs` | Yes | Core engine: claim model + deterministic conflict checks; trust/confidence; store-time supersession/quarantine; explainable search & rerank; `context()` with budget packing; `decay()`, `consolidate()`, `autoCompress()`, batch ops (`storeMany`, `searchMany`), and `ingest()` via extraction provider. citeturn20view0turn14view0turn7view2turn45view0turn46view0turn45view2 |
| `src/storage.mjs` | Yes | JSON storage plus in-memory storage; **persists episodes, clusters, pending conflicts** as separate JSON files for local mode. citeturn10view0 |
| `src/supabase-storage.mjs` | Yes | Maps `claim`, `provenance`, `confidence`, `status`, `quarantine`, `reinforcements`, `disputes`, `superseded_by`, `supersedes`; includes basic rate-limit retry and error redaction. citeturn10view1 |
| `src/embeddings.mjs` | Yes | OpenAI-compatible embeddings with optional `embedQuery()` for asymmetric models (e.g., NVIDIA NIM), plus noop provider. citeturn30view0turn30view2 |
| `src/extraction.mjs` | Yes | LLM-based extraction fences raw input inside XML tags to mitigate prompt injection; produces structured facts with category/importance/tags. citeturn29view1 |
| `src/validate.mjs` | Yes | Base URL validation blocks cloud metadata endpoints and private IPs by default (SSRF guard), allowing localhost only when required. citeturn28view1 |
| `src/writethrough.mjs` | Yes | Event-driven “write-through”: append markdown on `store` and/or POST webhooks; useful for ops + audit trails. citeturn28view0 |
| `cli/index.mjs` | Yes | CLI supports `store`, `search`, `search-all`, `evolve`, traversal utilities, etc. Useful for smoke tests. citeturn11view4 |
| `sql/schema.sql` | Yes | Base Supabase schema (memories, links, archive, RPC search). Does **not** include all v0.8 trust/claim columns—migration does. citeturn18view0 |
| `sql/migration-v0.8.sql` | Yes | Adds `claim`, `provenance`, `confidence`, `status`, `quarantine`, supersession fields + `pending_conflicts`, `episodes`, `memory_clusters`, RLS suggestions. citeturn18view2 |
| `test/claims.test.mjs` | Yes | Tests deterministic conflict semantics: exclusivity, validity overlap, superseded/quarantined excluded, session scope rules, dedupe/corroboration, and backwards compatibility (store without claim). citeturn38view0 |
| `.github/workflows/*` | Not found | No CI workflow files were retrievable in this audit; you’ll want CI for regression + poisoning harness. citeturn36view0turn36view1 |
| `docs/*` | Not found | No docs folder files were retrievable here; consider adding an “architecture & semantics” spec for contributors. citeturn43view3 |

## Data models and API design for the addendum

### Canonical data model

The repo already converges on a strong “memory record” model suitable for either JSON persistence or relational storage (Supabase), and the migration formalises supporting tables for conflicts, episodes, and clusters. citeturn10view1turn18view2

Below is a **TypeScript-oriented** model that matches the repo’s current fields and adds a few addendum-specific conveniences (topic fields, explainability envelopes, quarantine workflow status). Where a field is not clearly present in current code, it is marked **optional** and called out in notes.

```ts
export type MemoryStatus = "active" | "superseded" | "disputed" | "quarantined" | "archived";

export type ClaimScope = "global" | "session" | "temporal"; // repo validates these three citeturn19view1

export interface MemoryClaim {
  subject: string;              // required
  predicate: string;            // required
  value: string;                // required
  normalizedValue?: string;     // set by normaliser citeturn6view1

  scope: ClaimScope;
  sessionId?: string;           // required if scope==="session" citeturn19view1
  exclusive?: boolean;          // default true citeturn38view0

  validFrom?: string;           // ISO time; used for overlap checks citeturn38view0
  validUntil?: string;          // ISO time; used for overlap checks citeturn38view0
}

export type ProvenanceSource =
  | "user_explicit" | "system" | "tool_output" | "user_implicit" | "document" | "inference";

export interface MemoryProvenance {
  source: ProvenanceSource;
  sourceId?: string;
  corroboration: number;        // increments when corroborated/deduped citeturn38view0turn20view0
  trust: number;                // computed trust 0..1 citeturn6view1turn38view0
}

export interface QuarantineInfo {
  reason: "trust_insufficient" | "predicate_requires_review" | "suspicious_input" | "manual";
  created_at: string;
  details?: Record<string, any>;
  resolved_at?: string;
  resolution?: "activate" | "reject" | "keep_quarantined";   // addendum ergonomic
}

export interface MemoryRecord {
  id: string;
  agent: string;
  memory: string;
  category: "decision" | "finding" | "fact" | "insight" | "task" | "event" | "preference" | "digest";

  tags: string[];
  embedding: number[] | null;

  created_at: string;
  updated_at: string;
  event_at?: string;

  importance: number;           // 0..1
  accessCount: number;

  claim?: MemoryClaim;
  provenance: MemoryProvenance;
  confidence: number;           // in repo: equals trust (decoupled from importance/recency) citeturn6view1turn38view0

  status: MemoryStatus;
  quarantine?: QuarantineInfo;

  reinforcements: number;
  disputes: number;

  superseded_by?: string;
  supersedes?: string[];

  links: Array<{ id: string; similarity: number; type?: "similar" | "supersedes" | string }>;
}
```

### Predicate schema registry as a first-class artefact

The repo implements an in-memory registry with validation and default schema. citeturn6view1  
To fully meet your addendum goals (portable, auditable semantics), make predicate schema a persisted artefact:

```ts
export type Cardinality = "single" | "multi";
export type ConflictPolicy = "supersede" | "require_review" | "keep_both";
export type Normalizer = "none" | "trim" | "lowercase" | "lowercase_trim" | "currency";
export type DedupPolicy = "corroborate" | "store";

export interface PredicateSchema {
  predicate: string;
  cardinality: Cardinality;
  conflictPolicy: ConflictPolicy;
  normalize: Normalizer;
  dedupPolicy: DedupPolicy;

  // v0.8.1 addendum nice-to-have:
  minTrustToSupersede?: number;     // override default trust-gated compare
  quarantineOnSuspicion?: boolean;
}
```

**Proposed Supabase table (new):**

- `predicate_schemas(predicate text primary key, schema jsonb not null, updated_at timestamptz not null default now(), version int not null default 1)`

This makes conflict semantics portable across deployments, and supports future “schema migrations” (e.g., changing `currency` normalisation behaviour) with a trail.

### API surface

The repo already has `store()`, `search()`, `context()`, `consolidate()`, plus `explainMemory()` and `explainSupersession()`, and batch helpers. citeturn20view0turn14view0turn7view2turn45view0turn15view2turn46view0  
The addendum workflows are best added as a small “agent-runtime” module that composes these primitives rather than bloating the core graph.

#### Store

Current signature supports claim/provenance, plus trust-gated conflict handling with `onConflict` and manual quarantine. citeturn19view1turn20view0

```ts
export interface StoreOptions {
  category?: string;
  importance?: number;
  tags?: string[];
  eventTime?: string | Date;

  claim?: MemoryClaim;
  provenance?: Partial<Pick<MemoryProvenance, "source" | "sourceId">>;

  quarantine?: boolean;                 // manual
  onConflict?: "quarantine" | "keep_active"; // repo validates this citeturn19view1
}

export interface StoreResult {
  id: string;
  links: number;
  topLink: string;
  quarantined?: true;
  pendingConflictId?: string;
  deduplicated?: true;
}
```

**Example call payload:**

```ts
await mem.store("agent-1", "Budget is £750", {
  category: "fact",
  tags: ["budget", "travel"],
  claim: { subject: "user", predicate: "budget", value: "GBP 750", scope: "session", sessionId: "s_123" },
  provenance: { source: "user_explicit" },
  onConflict: "quarantine"
});
```

#### Search + explain

Search already supports: `statusFilter` and include flags, `sessionId` override logic, rerank weights, and explain mode returning per-result breakdown and overall `meta` (counts + excluded reasons). citeturn14view0turn7view2

```ts
export interface SearchOptions {
  limit?: number;
  minSimilarity?: number;

  before?: string;
  after?: string;

  rerank?: boolean | Partial<{ relevance: number; confidence: number; recency: number; importance: number }>;

  includeAll?: boolean;
  statusFilter?: MemoryStatus[];
  includeSuperseded?: boolean;
  includeDisputed?: boolean;
  includeQuarantined?: boolean;

  sessionId?: string;

  explain?: boolean;
}
```

**Addendum improvement**: extend explain to include a per-candidate exclusion list (IDs + reason) for true “why excluded” debugging (useful for CI and production incidents), not only aggregate counts.

#### Context with budget-aware packing

`context(query,{maxTokens})` currently: retrieves results, expands linked memories, reranks, then packs items using a **greedy value-density heuristic** (`score/tokens`) and returns excluded info when `explain=true`. citeturn7view2

For v0.8.1 “token-efficiency as a metric”, consider upgrading packing to a deterministic knapsack variant (see scoring section).

#### Consolidate

`consolidate()` already implements the full lifecycle, including optional pruning of quarantined items by age and access count rules. citeturn45view0turn21view1

#### Heartbeat task, topic recall, pre-compaction dump

Add these as new exported helpers (new module, e.g., `src/runtime.mjs`) to keep the memory core clean:

```ts
export interface ConversationTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
}

export interface HeartbeatConfig {
  debounceMs: number;                // e.g. 30_000
  minNewTokens: number;              // avoid storing trivial deltas
  minImportance: number;             // pass-through to ingest() citeturn45view2
  sessionId?: string;
  agent: string;
}

export interface HeartbeatResult {
  storedFacts: number;
  ids: string[];
  skippedReason?: "debounced" | "no_signal" | "provider_missing";
}

export async function heartbeatTask(
  mem: ReturnType<typeof createMemory>,
  turns: ConversationTurn[],
  cfg: HeartbeatConfig
): Promise<HeartbeatResult>;
```

These helpers operationalise the same “distil during run; consolidate after run” pattern that OpenAI’s context-personalisation cookbook recommends, without forcing neolata-mem to own the agent loop. citeturn32search3turn32search7

## Deterministic conflict semantics, trust gating, and ranking

### Deterministic conflict semantics

The codebase already encodes “deterministic over probabilistic” semantics at the claim layer:

- **Keying**: conflict checks are keyed by `(subject,predicate)` through an internal claim index. citeturn7view1turn38view0  
- **Cardinality**: if the predicate schema says `multi`, structural conflict checks short-circuit (no “single truth” to supersede). citeturn7view1turn6view1  
- **Exclusivity**: `exclusive=false` disables contradictions even on single-cardinality predicates (explicit multi-valued exceptions). citeturn38view0turn7view1  
- **Validity overlap**: contradictions require overlapping validity windows (temporal claims can coexist if their windows don’t overlap). citeturn38view0turn7view1  
- **Scope**:
  - `scope="session"` requires `sessionId` (validated on write). citeturn19view1turn38view0  
  - session-scoped claims **do not conflict** with global claims during structural checks, allowing “for this trip / for this session” overrides. citeturn38view0turn7view1  
  - search additionally implements a session override merge, preferring session-scoped records for the same `(subject,predicate)` when `sessionId` is supplied. citeturn14view0

These rules map cleanly onto MemoryAgentBench’s emphasis that memory agents must handle not only retrieval, but also **selective forgetting / overwrite in the presence of contradictions** (one of the benchmark’s core competencies). citeturn33view0turn34view1

### Trust gating and quarantine rules

The repo’s trust model is explicit:

- `computeTrust()` assigns a base trust by provenance source (e.g., `user_explicit` higher than `inference`) and adds small adjustments for corroboration and feedback. citeturn6view1turn38view0  
- On `store()` with a claim, if structural conflicts exist:
  - If predicate schema requires review, the new memory is quarantined (depending on `onConflict`) and a pending conflict record is created. citeturn20view0  
  - If conflict policy is `keep_both`, the system records a resolved “keep both” conflict. citeturn20view0  
  - Otherwise, the system performs **trust-gated supersession**: supersede existing if `newTrust >= existingTrust`, else quarantine the new memory and create a pending conflict. citeturn20view0

This is directly aligned with both ACC’s argument that retrieval-based memory can destabilise agents via noisy/outdated recall and that we need stronger “commitment control” over what becomes persistent state, and OWASP’s warnings that memory/vector systems are exposed to conflict and poisoning risks. citeturn35view0turn32search0turn32search1

**Addendum hardening rule-set (proposed)**: keep the existing trust-compare default, but add deterministic guardrails:

- **Supersede only if**: (a) `newTrust - oldTrust >= Δmin` *or* new is explicit user/system source, and (b) predicate schema allows supersede, and (c) input passes suspicion checks.
- **Quarantine if**: (a) low trust, (b) `require_review`, (c) suspicious input (see poisoning section), (d) cross-tenant/multi-agent boundary violation.
- **Keep both if**: predicate schema declares `multi` or `keep_both`, or validity windows do not overlap.

### Ranking, re-ranking, and budget-aware packing

#### Current reranking formula

Search results are reranked using a weighted composite, where each result has:

- `relevance`: base similarity score
- `confidence`: repo defines confidence as trustworthiness only (to avoid “double-counting” importance/recency) citeturn6view1turn14view0
- `recency`: exponential decay in days
- `importance`: user/LLM assigned importance

The composite is:

`composite = w_rel*relevance + w_conf*confidence + w_rec*recency + w_imp*importance`

with defaults `0.40/0.25/0.20/0.15`. citeturn14view0turn21view1

This is structurally similar to the classic “relevance+recency+importance” formulation used in agent-memory literature, and it also supports MemoryAgentBench’s “accurate retrieval” by ensuring similarity is not the only driver. citeturn34view1turn14view0

#### Current budget-aware context packing

When `maxTokens` is set, `context()` reranks candidates then greedily includes items by **value density** (approximately `(score or composite)/tokens`) until budget is exhausted, returning excluded IDs and reasons when `explain=true`. citeturn7view2

This is good enough for a first release, but the addendum goal (“highest-value memories that fit”) is more precisely met by a knapsack-style optimiser.

#### Proposed deterministic knapsack optimiser

Treat packing as 0/1 knapsack:

- Item weight `w_i = estimateTokens(memory_i)`
- Item value `v_i = compositeScore_i` (or a scaled integer)
- Budget `W = maxTokens - overhead`

For typical candidates `n ≤ 60` and budgets `W ≤ 4000`, DP is feasible:

- Complexity: `O(nW)` time, `O(W)` memory with backpointers (or store decisions sparsely).
- Determinism: stable ordering and tie-breakers are critical for debuggability.

Pseudo-outline:

```ts
// dp[t] = best value for token budget t
// take[t] = last item index chosen to reach dp[t] (for reconstruction)
for item i in candidates:
  for t from W down to w_i:
    if dp[t-w_i] + v_i > dp[t]:
      dp[t] = dp[t-w_i] + v_i
      take[t] = i
```

**Addendum-friendly extensions** (optional but high leverage):

- Reserve fixed “category quotas” (e.g., always include top-1 decision, top-1 preference) before knapsack.
- Penalise near-duplicates (diversity term) to reduce retrieval noise (a known failure mode in memory systems and a security issue in PoisonedRAG-style attacks where poisoned items can dominate retrieval). citeturn31search1turn31search13

## Workflows and pipelines

### Existing consolidation lifecycle in repo

Your consolidation pipeline is already close to what AWS AgentCore describes (extract → consolidate → retrieve), and it’s packaged as one call:

- `autoCompress()` compresses stale clusters into digests. citeturn45view0  
- `decay()` applies strength thresholds to archive/delete memories and cleans broken links. citeturn45view1  
- `consolidate()` runs:
  - dedupe (embedding similarity + trust winner)
  - structural contradiction resolution (claim-based)
  - corroboration boosts across similar items from different sources
  - compression of stale clusters
  - pruning rules (superseded by age, disputed low-trust, optional quarantine pruning) citeturn45view0turn21view1

AWS AgentCore’s public guidance similarly frames long-term memory as extraction + consolidation + retrieval, aiming to convert raw interactions into actionable knowledge and keep memory healthy over time. citeturn0search2turn32search2

**Key gap for scale**: the dedupe and corroboration loops are pairwise and can degrade toward `O(N²)` in large stores. With the default `maxMemories=50,000` this becomes a practical concern. citeturn13view0turn45view0  
Mitigation: use approximate nearest neighbour search (server-side vector index or a local HNSW) to only compare each memory to its top-k nearest neighbours; and for claims, avoid embedding-based dedupe by using schema-aware normalisation + hashing.

### Workflow design for v0.8.1 addendum

These are best shipped as **agent-runtime helpers** that compose existing library calls, mirroring the OpenAI approach: distil notes during a run; consolidate after the run; inject state at the next run. citeturn32search3turn32search7

#### Heartbeat auto-store

Goal: eliminate reliance on the agent “remembering to store”.

**Triggers (deterministic):**
- After any tool execution that produces durable facts (e.g., “budget updated”, “deployed to prod”).
- When the conversation’s rolling token count crosses a threshold (e.g., 70% of context window), especially if a pre-compaction dump is not yet saved.
- On idle / debounce (no new user input for `debounceMs`).

**Mechanism:**
- Use `ingest(agent, text, {minImportance})` on a compacted “turn bundle” (last N turns, tool outputs, decisions). `ingest()` already calls the extraction provider and stores facts. citeturn45view2turn29view1
- Store summary facts as `scope="session"` claims with `sessionId` to avoid permanently overriding global state unless verified. citeturn19view1turn14view0

#### Contextual recall by topic

Goal: reduce retrieval noise by using topic as an explicit filter.

**Recommended approach:**
- Treat “topic” as a first-class predicate schema:
  - `subject="session"` or `subject="user"` (depending on meaning)
  - `predicate="topic"`
  - `value` = canonical topic slug (normalised)
  - `cardinality="single"` at the session level; `multi` at the user level if you want long-term interests.

Use extraction tags as a seed signal: extraction outputs `tags[]`, which can be used to infer topic clusters. citeturn29view1turn45view2

Implementation pattern:
1. Derive `topicId` from current query (embedding similarity against a small dictionary of known topics, or rule-based keyword mapping).
2. Issue `search(agent, query, { ... })`
3. Re-rank with a topic match multiplier:
   - if `memory.tags` includes `topicId`, multiply value by `1.15`
   - if not, multiply by `1.0`
4. Pack with knapsack to maximise value under `maxTokens`.

This is a deterministic alternative to perpetual “LLM consolidation on each write” (noted as expensive in managed systems) and aligns with the benchmark need for robust multi-turn retrieval and forgetting under topic shift. citeturn33view0turn34view1turn32search6

#### Pre-compaction structured dump

Goal: when the agent is about to lose context (or before aggressive compression), persist a structured session snapshot that preserves rationale, open threads, and decisions.

A robust dump schema (stored as `category="digest"` or `category="event"`) might include:

- `sessionId`, `activeTopic`, `goals`, `decisions`, `openQuestions`, `risks`, `nextActions`
- references (`memoryIds`) to the most relevant underlying memories (so you can reconstruct later even if text is compressed)

Operational tie-in: OpenAI’s cookbook and related write-ups emphasise that trimming/compaction should keep recent conversation plus reinject important notes; a structured pre-dump makes that reliable. citeturn32search3turn32search7

### Mermaid flowchart for consolidation + heartbeat + quarantine

```mermaid
flowchart TD
  A[New conversation turn / tool output] --> B{Heartbeat trigger?}
  B -->|No| Z[Continue]
  B -->|Yes| C[Bundle last N turns + tool outputs]
  C --> D[Extract facts via extraction provider]
  D --> E[store() each fact with claim+provenance]

  E --> F{Structural conflict? (subject,predicate)}
  F -->|No| Z
  F -->|Yes| G{Predicate conflictPolicy}
  G -->|keep_both| H[Record keep_both conflict]
  G -->|require_review| Q[Quarantine new memory + pending_conflict]
  G -->|supersede| I{newTrust >= oldTrust?}
  I -->|Yes| J[Supersede old; add supersedes edge]
  I -->|No| Q

  Q --> K[Human/LLM review workflow]
  K -->|activate| L[Resolve conflict + unquarantine + (optional) supersede]
  K -->|reject| M[Archive quarantined memory]

  N[Scheduled / on-demand consolidate()] --> O[Dedup + contradictions + corroboration]
  O --> P[Compress stale clusters]
  P --> R[Prune: superseded/disputed/decayed (+ optional quarantined)]
```

## Security controls, metrics, and test programme

### Threat model alignment

The addendum’s quarantine + provenance posture is justified by current research:

- **PoisonedRAG** demonstrates that small-scale knowledge poisoning can achieve very high attack success rates in RAG settings, meaning your memory layer needs provenance controls and monitoring. citeturn31search1turn31search13  
- **AgentPoison** targets LLM agents by poisoning long-term memory / knowledge bases as a backdoor mechanism. citeturn31search6turn31search2  
- **MemoryGraft** shows persistent compromise via poisoned “experience retrieval”, where the agent imitates malicious procedure templates surfaced by similarity-based recall. citeturn31search3turn31search15  
- OWASP guidance explicitly calls out agent memory as a unique risk surface and highlights vector/embedding weaknesses including cross-context leakage and conflicting knowledge federation. citeturn32search0turn32search1

### Controls already present in repo

- **SSRF / base URL validation** blocks metadata endpoints and private IP ranges by default. citeturn28view1  
- **Extraction prompt injection mitigation** fences raw text and instructs the model not to follow embedded instructions. citeturn29view1  
- **Trust-gated supersession + quarantine + pending conflicts** already exists at store-time. citeturn20view0turn18view2  
- **Error redaction** in Supabase storage sanitises bearer tokens / JWT-like strings before raising errors. citeturn10view1

### Addendum controls to implement

Emphasise controls that directly mitigate PoisonedRAG/AgentPoison/MemoryGraft dynamics:

- **Provenance chain hardening**: extend provenance to include `who/what` asserted the memory (agent/tool/user), plus content hash and optional signature for “trusted tools”.
- **Suspicion scoring**: auto-quarantine when text contains injection markers (“ignore previous”, “system prompt”, credential asks) or when a low-trust source asserts high-impact predicates (e.g., `payment_destination`, `auth_policy`).
- **Safety-aware re-ranking**: damp items with low trust or suspicious provenance so they don’t dominate retrieval, a key pattern in MemoryGraft-style retrieval abuse. citeturn31search3
- **Review workflow + audit**: a human/LLM reviewer must be able to see *why* something was quarantined and *why* it would supersede.

### Metrics

Use both HEART-style product metrics and “memory quality” metrics used in research:

- **Context drift error rate**: % of agent responses that use a superseded/outdated claim when a newer session-scoped claim exists.
- **Contradiction exposure rate**: % of retrieval contexts that contain conflicting `(subject,predicate)` values without an explicit precedence rule.
- **Poisoning resistance**: attack success rate under a standard poisoning harness (see below).
- **Token-efficiency**: task success per token budget; this directly ties to `context(...,{maxTokens})` packing quality.
- **Memory footprint growth**: total memories + digests; ACC highlights bounded memory footprint as a stability driver and evaluates drift/hallucination over long horizons. citeturn35view0turn31search0

### Test plan and benchmark suite

Map directly to MemoryAgentBench competencies (and its dataset components like FactConsolidation/EventQA), plus ACC-style drift audits and poisoning corpora.

- **MemoryAgentBench mapping**: validate performance on accurate retrieval + selective forgetting scenarios; MemoryAgentBench explicitly evaluates these as core competencies and provides multi-turn incremental format. citeturn33view0turn34view1turn0search1  
- **ACC-inspired drift audit**: run 50-turn scenarios with evolving constraints and injected distractions, scoring drift and hallucination against a canonical state, mirroring ACC’s emphasis on drift/hallucination auditing in long-horizon multi-turn settings. citeturn35view0turn31search0  
- **Poisoning harness**:
  - PoisonedRAG-style: inject a small number of adversarial documents/memories and measure whether they dominate retrieval under similarity and cause wrong answers. citeturn31search1turn31search9  
  - AgentPoison-style: implant a “triggered” malicious memory and test activation under semantically similar queries. citeturn31search6turn31search14  
  - MemoryGraft-style: implant malicious “successful procedure templates” and measure imitation likelihood when retrieved. citeturn31search3turn31search15

### Sample CI job YAML for regression + poisoning tests

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm test

  benchmark-memory:
    runs-on: ubuntu-latest
    needs: test
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      # Example: run a lightweight harness that replays benchmark traces
      - run: node scripts/bench-memoryagentbench.mjs --subset FactConsolidation --maxTurns 50

  redteam-poisoning:
    runs-on: ubuntu-latest
    needs: test
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
      # Example: deterministic poisoning harness; asserts quarantine + non-dominance in retrieval
      - run: node scripts/redteam-poisoning.mjs --suite poisonedrag,agentpoison,memorygraft
```

## Migration notes and implementation roadmap

### Migration and backwards compatibility

- Database: if deploying on Supabase, the repo provides a **v0.8 migration SQL** adding trust/claim/quarantine fields and support tables (`pending_conflicts`, `episodes`, `memory_clusters`) plus updated RPC search and suggested RLS enablement. citeturn18view2  
- Backwards compatibility: tests confirm `store()` without a claim remains valid and doesn’t attach a `claim` field. citeturn38view0  
- Runtime config: `createMemory()` cleanly supports optional providers (noop embeddings, optional extraction/llm) and passes `predicateSchemas` to the graph config. citeturn27view1

### Feature vs required capability matrix

| Capability | Required by addendum | Current repo status | Gap / action |
|---|---|---|---|
| Predicate schema registry (cardinality + conflict policy + normalisation) | Yes | Implemented in-memory with validation + normalisers; used in conflict check and claim normalisation. citeturn6view1turn19view1 | Persist schemas in storage (Supabase + JSON) for portability + audit; add versioning + admin tooling. |
| Explainability API (why retrieved / superseded / excluded) | Yes | `search(...,{explain:true})` returns per-result retrieved+rerank; `context(...,{explain:true})` includes packing and excluded-by-budget; `explainMemory` + `explainSupersession` exist. citeturn14view0turn7view2turn15view2 | Add per-candidate exclusion list (IDs + reasons), not only aggregates; add `explain()` envelope for consolidate/quarantine decisions. |
| Quarantine lane + pending conflict workflow | Yes | Store-time quarantine + pending conflicts; prune options in consolidate; DB table exists. citeturn20view0turn45view0turn18view2 | Ensure explicit public APIs for listing/reviewing quarantined + resolving conflicts; add UI/CLI hooks; add suspicion auto-quarantine rules. |
| Heartbeat auto-store workflow | Yes | Not first-class; no heartbeat entrypoint in graph. citeturn19view2 | Add runtime helper module (`heartbeatTask`) composing `ingest()` and `store()`; add debounce + trigger heuristics. |
| Contextual recall by topic | Yes | Tags exist; no explicit “topic recall” workflow; search lacks topic filter in surfaced signature. citeturn14view0turn29view1 | Add `topic`/`tags` filter + topic-aware rerank multiplier; store topic claims per session. |
| Pre-compaction structured dump | Yes | No explicit compaction/dump API; context supports token budgets but doesn’t generate structured session snapshots. citeturn7view2turn19view4 | Add `preCompactionDump()` helper producing structured digest + references; feed into `store()` as session-scoped digest. |

### Prioritised roadmap milestones

| Milestone | Scope | Effort | Acceptance criteria |
|---|---|---:|---|
| Runtime workflows v0 | Heartbeat auto-store + pre-compaction dump helpers | Medium | Deterministic triggers; stores session-scoped digests; unit tests cover debounce + “no-signal” cases; no raw tool output persisted without provenance. |
| Topic-aware recall v0 | Topic detection + search filters + topic-weighted rerank | Medium | `contextByTopic()` consistently reduces irrelevant items vs baseline in a curated eval set; token-efficiency improves under fixed budget. |
| Quarantine review ergonomics | `listQuarantined`, `reviewQuarantine`, `listPendingConflicts`, `resolveConflict` (or equivalents) + CLI | Medium | Review actions update status/resolution deterministically; conflicts are never silently dropped; full explain trace available. |
| Persisted predicate registry | `predicate_schemas` table + JSON storage + export/import | Small | Registry survives restarts; schema version tracked; conflict outcomes change only when schema version changes. |
| Knapsack packing v1 | Replace greedy packing with DP knapsack (with stable tie-breaks) | Small–Medium | For fixed candidates and budget, packing is deterministic and yields ≥ greedy total value in synthetic tests. |
| Poisoning harness + CI | Add red-team suite + MemoryAgentBench subset replay | Large | CI runs fast subset; fails on regression in contradiction exposure rate and poisoning resistance thresholds; reports metrics artefacts. |

### Bottom line on “the angle”

The repo already embodies the product angle you proposed: **self-healing memory** via structural contradiction handling, trust-gated supersession, quarantine, explainable retrieval, and consolidation. That positioning is strongly supported by: (a) benchmark trends emphasising selective forgetting/conflict resolution (MemoryAgentBench), (b) ACC’s framing that uncontrolled retrieval/state leads to drift and instability, and (c) the accelerating body of poisoning work showing persistent compromise via memory/RAG stores. citeturn34view1turn35view0turn31search1turn31search6turn31search3