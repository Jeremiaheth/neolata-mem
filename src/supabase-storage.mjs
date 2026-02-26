/**
 * Supabase Storage Backend for neolata-mem.
 *
 * Implements the storage contract (load, save, loadArchive, saveArchive, genId)
 * using Supabase REST API. Also provides optional incremental methods
 * (upsert, delete, search) that MemoryGraph can use when available.
 *
 * @param {object} opts
 * @param {string} opts.url - Supabase project URL (e.g. https://xxx.supabase.co)
 * @param {string} opts.key - Supabase service key or anon key
 * @param {string} [opts.table='memories'] - Main memories table name
 * @param {string} [opts.linksTable='memory_links'] - Links table name
 * @param {string} [opts.archiveTable='memories_archive'] - Archive table name
 * @param {Function} [opts.fetch] - Custom fetch (for testing/mocking)
 */

import { randomUUID } from 'crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUUID(id, label = 'id') {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`${label} must be a valid UUID, got: ${String(id).slice(0, 50)}`);
  }
}

/** Sanitize API error text — strip potential secrets */
function sanitizeErrorText(text) {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\b/g, '[JWT_REDACTED]')
    .replace(/\b(sk-|nvapi-|key-)[A-Za-z0-9_-]{10,}\b/g, '[KEY_REDACTED]');
}

export function supabaseStorage({
  url,
  key,
  table = 'memories',
  linksTable = 'memory_links',
  archiveTable = 'memories_archive',
  pendingConflictsTable = 'pending_conflicts',
  fetch: customFetch,
} = {}) {
  if (!url) throw new Error('supabaseStorage: url is required');
  if (!key) throw new Error('supabaseStorage: key is required');

  // Normalize: strip trailing slash from URL
  const baseUrl = url.replace(/\/+$/, '');
  const _fetch = customFetch || globalThis.fetch;

  // ── HTTP helper with retry on 429 ──
  async function request(method, path, body = null, extraHeaders = {}, _retryCount = 0) {
    const res = await _fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      if (_retryCount >= 3) throw new Error(`Supabase ${method} ${path} → 429: rate limited after 3 retries`);
      const backoff = 1000 * Math.pow(2, _retryCount);
      await new Promise(r => setTimeout(r, backoff));
      return request(method, path, body, extraHeaders, _retryCount + 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase ${method} ${path} → ${res.status}: ${sanitizeErrorText(text.slice(0, 300))}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── Field mapping: internal ↔ Supabase ──
  function toRow(mem) {
    return {
      id: mem.id,
      agent_id: mem.agent,
      content: mem.memory,
      category: mem.category,
      importance: mem.importance,
      tags: mem.tags || [],
      embedding: mem.embedding || null,
      created_at: mem.created_at,
      updated_at: mem.updated_at || mem.created_at,
      access_count: mem.accessCount || 0,
      stability: mem.stability ?? null,
      last_review_interval: mem.lastReviewInterval ?? null,
      claim: mem.claim ?? null,
      provenance: mem.provenance ?? null,
      confidence: mem.confidence ?? null,
      status: mem.status || 'active',
      quarantine: mem.quarantine ?? null,
      reinforcements: mem.reinforcements ?? 0,
      disputes: mem.disputes ?? 0,
      superseded_by: mem.superseded_by ?? null,
      supersedes: mem.supersedes ?? null,
    };
  }

  function fromRow(row) {
    return {
      id: row.id,
      agent: row.agent_id ?? row.agent,
      memory: row.content ?? row.memory,
      category: row.category,
      importance: row.importance,
      tags: row.tags || [],
      embedding: typeof row.embedding === 'string'
        ? JSON.parse(row.embedding)
        : (row.embedding || null),
      links: [], // Links loaded separately
      created_at: row.created_at,
      updated_at: row.updated_at || row.created_at,
      accessCount: row.access_count || 0,
      stability: row.stability ?? undefined,
      lastReviewInterval: row.last_review_interval ?? undefined,
      claim: row.claim ?? undefined,
      provenance: row.provenance ?? undefined,
      confidence: row.confidence ?? undefined,
      status: row.status || 'active',
      quarantine: row.quarantine ?? undefined,
      reinforcements: row.reinforcements ?? 0,
      disputes: row.disputes ?? 0,
      superseded_by: row.superseded_by ?? undefined,
      supersedes: row.supersedes ?? undefined,
    };
  }

  function toArchiveRow(mem) {
    return {
      id: mem.id,
      agent_id: mem.agent,
      content: mem.memory,
      category: mem.category,
      importance: mem.importance,
      tags: mem.tags || [],
      created_at: mem.created_at,
      archived_at: mem.archived_at || new Date().toISOString(),
      archived_reason: mem.archived_reason || null,
    };
  }

  function fromArchiveRow(row) {
    return {
      id: row.id,
      agent: row.agent_id,
      memory: row.content,
      category: row.category,
      importance: row.importance,
      tags: row.tags || [],
      links: [],
      created_at: row.created_at,
      archived_at: row.archived_at,
      archived_reason: row.archived_reason || undefined,
    };
  }

  // ── Load links and attach to memories ──
  async function loadLinks(memories) {
    if (memories.length === 0) return;

    const linkMap = new Map();
    let offset = 0;
    while (true) {
      const batch = await request('GET',
        `/rest/v1/${linksTable}?select=source_id,target_id,strength&limit=1000&offset=${offset}`);
      if (!batch || batch.length === 0) break;
      for (const l of batch) {
        // Bidirectional
        if (!linkMap.has(l.source_id)) linkMap.set(l.source_id, []);
        linkMap.get(l.source_id).push({ id: l.target_id, similarity: l.strength, type: l.link_type || 'similar' });
        if (!linkMap.has(l.target_id)) linkMap.set(l.target_id, []);
        linkMap.get(l.target_id).push({ id: l.source_id, similarity: l.strength, type: l.link_type || 'similar' });
      }
      if (batch.length < 1000) break;
      offset += 1000;
    }

    for (const mem of memories) {
      mem.links = linkMap.get(mem.id) || [];
    }
  }

  return {
    name: 'supabase',

    async load() {
      const rows = await request('GET',
        `/rest/v1/${table}?select=id,agent_id,content,category,importance,tags,embedding,created_at,updated_at,access_count,stability,last_review_interval,claim,provenance,confidence,status,quarantine,reinforcements,disputes,superseded_by,supersedes,compressed&order=created_at.asc&limit=50000`);
      const memories = (rows || []).map(fromRow);
      await loadLinks(memories);
      return memories;
    },

    async save(memories) {
      // Upsert-based save: batch upsert all memories, then reconcile links.
      // Much safer than delete-all + re-insert (no data loss on crash).
      if (memories.length === 0) {
        // Empty save = clear all
        await request('DELETE', `/rest/v1/${linksTable}?id=not.is.null`);
        await request('DELETE', `/rest/v1/${table}?id=not.is.null`);
        return;
      }

      // Batch upsert memories (on conflict: update)
      for (let i = 0; i < memories.length; i += 50) {
        const batch = memories.slice(i, i + 50).map(toRow);
        await request('POST', `/rest/v1/${table}`, batch, {
          'Prefer': 'return=minimal,resolution=merge-duplicates',
        });
      }

      // Delete memories that are in DB but not in the new set
      const keepIds = new Set(memories.map(m => m.id));
      const existing = await request('GET', `/rest/v1/${table}?select=id&limit=50000`);
      const staleIds = (existing || []).filter(r => !keepIds.has(r.id)).map(r => r.id);
      for (let i = 0; i < staleIds.length; i += 50) {
        const batch = staleIds.slice(i, i + 50);
        await request('DELETE', `/rest/v1/${table}?id=in.(${batch.join(',')})`);
      }

      // Reconcile links: clear and re-insert (links are cheap, memories are not)
      await request('DELETE', `/rest/v1/${linksTable}?id=not.is.null`);
      const linkRows = [];
      const seen = new Set();
      for (const mem of memories) {
        for (const link of (mem.links || [])) {
          const pair = [mem.id, link.id].sort().join('|');
          if (seen.has(pair)) continue;
          seen.add(pair);
          linkRows.push({
            id: randomUUID(),
            source_id: mem.id,
            target_id: link.id,
            strength: link.similarity,
            created_at: mem.created_at,
          });
        }
      }
      for (let i = 0; i < linkRows.length; i += 50) {
        await request('POST', `/rest/v1/${linksTable}`, linkRows.slice(i, i + 50), { 'Prefer': 'return=minimal' });
      }
    },

    async loadArchive() {
      const rows = await request('GET',
        `/rest/v1/${archiveTable}?select=id,agent_id,content,category,importance,tags,created_at,archived_at,archived_reason&order=archived_at.asc&limit=50000`);
      return (rows || []).map(fromArchiveRow);
    },

    async saveArchive(archived) {
      await request('DELETE', `/rest/v1/${archiveTable}?id=not.is.null`);
      if (archived.length === 0) return;
      for (let i = 0; i < archived.length; i += 50) {
        const batch = archived.slice(i, i + 50).map(toArchiveRow);
        await request('POST', `/rest/v1/${archiveTable}`, batch, { 'Prefer': 'return=minimal' });
      }
    },
    async loadEpisodes() {
      const epTable = table.replace('memories', 'episodes');
      try {
        const rows = await request('GET',
          `/rest/v1/${epTable}?select=id,name,summary,agents,memory_ids,tags,metadata,time_range_start,time_range_end,created_at,updated_at&order=created_at.desc`);
        return (rows || []).map(r => ({
          id: r.id,
          name: r.name,
          summary: r.summary || undefined,
          agents: r.agents || [],
          memoryIds: r.memory_ids || [],
          tags: r.tags || [],
          metadata: r.metadata || undefined,
          timeRange: { start: r.time_range_start, end: r.time_range_end },
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      } catch {
        return [];
      }
    },
    async saveEpisodes(episodes) {
      const epTable = table.replace('memories', 'episodes');
      await request('DELETE', `/rest/v1/${epTable}?id=not.is.null`, null, { Prefer: 'return=minimal' });
      if (episodes.length > 0) {
        const rows = episodes.map(ep => ({
          id: ep.id,
          name: ep.name,
          summary: ep.summary || null,
          agents: ep.agents,
          memory_ids: ep.memoryIds,
          tags: ep.tags,
          metadata: ep.metadata || null,
          time_range_start: ep.timeRange?.start || null,
          time_range_end: ep.timeRange?.end || null,
          created_at: ep.created_at,
          updated_at: ep.updated_at,
        }));
        await request('POST', `/rest/v1/${epTable}`, rows, { Prefer: 'return=minimal' });
      }
    },
    async loadClusters() {
      const clTable = table.replace('memories', 'memory_clusters');
      try {
        const rows = await request('GET',
          `/rest/v1/${clTable}?select=id,label,description,memory_ids,created_at,updated_at&order=created_at.desc`);
        return (rows || []).map(r => ({
          id: r.id,
          label: r.label,
          description: r.description || undefined,
          memoryIds: r.memory_ids || [],
          created_at: r.created_at,
          updated_at: r.updated_at,
        }));
      } catch {
        return [];
      }
    },
    async saveClusters(clusters) {
      const clTable = table.replace('memories', 'memory_clusters');
      await request('DELETE', `/rest/v1/${clTable}?id=not.is.null`, null, { Prefer: 'return=minimal' });
      if (clusters.length > 0) {
        const rows = clusters.map(cl => ({
          id: cl.id,
          label: cl.label,
          description: cl.description || null,
          memory_ids: cl.memoryIds,
          created_at: cl.created_at,
          updated_at: cl.updated_at,
        }));
        await request('POST', `/rest/v1/${clTable}`, rows, { Prefer: 'return=minimal' });
      }
    },
    async loadPendingConflicts() {
      try {
        const rows = await request('GET',
          `/rest/v1/${pendingConflictsTable}?select=id,new_id,existing_id,new_trust,existing_trust,new_claim,existing_claim,created_at,resolved_at,resolution&order=created_at.asc`);
        return (rows || []).map(r => ({
          id: r.id,
          newId: r.new_id,
          existingId: r.existing_id,
          newTrust: r.new_trust,
          existingTrust: r.existing_trust,
          newClaim: r.new_claim ?? undefined,
          existingClaim: r.existing_claim ?? undefined,
          created_at: r.created_at,
          resolved_at: r.resolved_at ?? undefined,
          resolution: r.resolution ?? undefined,
        }));
      } catch {
        return [];
      }
    },
    async savePendingConflicts(conflicts) {
      const rows = (conflicts || []).map(c => ({
        id: c.id,
        new_id: c.newId,
        existing_id: c.existingId,
        new_trust: c.newTrust,
        existing_trust: c.existingTrust,
        new_claim: c.newClaim ?? null,
        existing_claim: c.existingClaim ?? null,
        created_at: c.created_at,
        resolved_at: c.resolved_at ?? null,
        resolution: c.resolution ?? null,
      }));
      await request('DELETE', `/rest/v1/${pendingConflictsTable}?id=not.is.null`, null, { Prefer: 'return=minimal' });
      if (rows.length > 0) {
        await request('POST', `/rest/v1/${pendingConflictsTable}`, rows, { Prefer: 'return=minimal' });
      }
    },

    genId() {
      return randomUUID();
    },
    genEpisodeId() {
      return randomUUID();
    },
    genClusterId() {
      return randomUUID();
    },

    // ── Incremental Operations ──
    // These bypass full save() for efficiency. MemoryGraph can detect
    // storage.incremental === true and use these when available.

    incremental: true,

    /**
     * Server-side vector search via Supabase RPC.
     * Returns null if RPC is not available (caller falls back to client-side).
     * @param {number[]} embedding - Query embedding vector
     * @param {object} opts
     * @param {string|null} [opts.agent] - Filter by agent (null = all)
     * @param {number} [opts.limit=10]
     * @param {number} [opts.minSimilarity=0.3]
     * @returns {Promise<Array|null>} Results or null if RPC unavailable
     */
    async search(embedding, { agent = null, limit = 10, minSimilarity = 0.3, status = 'active' } = {}) {
      const jsonEmbedding = JSON.stringify(embedding);
      const attempts = [
        {
          rpc: 'search_memories_semantic',
          body: {
            query_embedding: jsonEmbedding,
            match_threshold: minSimilarity,
            match_count: limit,
            filter_agent: agent,
            filter_status: status,
          },
        },
        {
          rpc: 'search_memories_semantic',
          body: agent
            ? { agent, query_embedding: jsonEmbedding, match_count: limit, min_similarity: minSimilarity }
            : { query_embedding: jsonEmbedding, match_count: limit, min_similarity: minSimilarity },
        },
      ];
      if (!agent) {
        attempts.push({
          rpc: 'search_memories_global',
          body: { query_embedding: jsonEmbedding, match_count: limit, min_similarity: minSimilarity },
        });
      }

      let firstErr = null;
      for (const attempt of attempts) {
        try {
          const results = await request('POST', `/rest/v1/rpc/${attempt.rpc}`, attempt.body);
          if (!results || !Array.isArray(results)) continue;
          return results.map(r => ({
            id: r.id,
            agent: r.agent_id ?? r.agent,
            memory: r.content ?? r.memory,
            category: r.category,
            importance: r.importance,
            tags: r.tags || [],
            claim: r.claim ?? undefined,
            provenance: r.provenance ?? undefined,
            confidence: r.confidence ?? undefined,
            status: r.status || 'active',
            quarantine: r.quarantine ?? undefined,
            reinforcements: r.reinforcements ?? 0,
            disputes: r.disputes ?? 0,
            created_at: r.created_at,
            updated_at: r.updated_at,
            score: r.similarity,
          }));
        } catch (err) {
          if (!firstErr) firstErr = err;
        }
      }

      if (firstErr) {
        const msg = firstErr?.message || '';
        if (!(msg.includes('404') || msg.includes('not found') || msg.includes('does not exist'))) {
          console.error(`[supabase-search] RPC failed (falling back to client-side): ${msg.slice(0, 200)}`);
        }
      }
      return null;
    },

    /**
     * Insert or update a single memory.
     * Uses Supabase upsert (on conflict: update).
     */
    async upsert(mem) {
      const row = toRow(mem);
      await request('POST', `/rest/v1/${table}`, row, {
        'Prefer': 'return=minimal,resolution=merge-duplicates',
      });
    },

    /**
     * Delete a single memory by id.
     * Also removes associated links (if FK CASCADE is set, Supabase handles this).
     */
    async remove(id) {
      assertUUID(id, 'remove: id');
      await request('DELETE', `/rest/v1/${linksTable}?or=(source_id.eq.${id},target_id.eq.${id})`);
      await request('DELETE', `/rest/v1/${table}?id=eq.${id}`);
    },

    /**
     * Insert links from a source memory to targets.
     * @param {string} sourceId
     * @param {Array<{id: string, similarity: number}>} links
     */
    async upsertLinks(sourceId, links) {
      assertUUID(sourceId, 'upsertLinks: sourceId');
      if (!links.length) return;
      // Normalize to canonical direction (sorted pair) to prevent bidirectional dupes.
      // loadLinks() already treats each row as bidirectional, so one row per pair suffices.
      const rows = links.map(l => {
        const [a, b] = [sourceId, l.id].sort();
        return {
          id: randomUUID(),
          source_id: a,
          target_id: b,
          strength: l.similarity,
          created_at: new Date().toISOString(),
        };
      });
      await request('POST', `/rest/v1/${linksTable}`, rows, {
        'Prefer': 'return=minimal,resolution=merge-duplicates',
      });
    },

    /**
     * Remove all links involving a memory (both as source and target).
     * @param {string} memoryId
     */
    async removeLinks(memoryId) {
      assertUUID(memoryId, 'removeLinks: memoryId');
      await request('DELETE', `/rest/v1/${linksTable}?or=(source_id.eq.${memoryId},target_id.eq.${memoryId})`);
    },
  };
}
