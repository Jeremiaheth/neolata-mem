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
  fetch: customFetch,
} = {}) {
  if (!url) throw new Error('supabaseStorage: url is required');
  if (!key) throw new Error('supabaseStorage: key is required');

  // Normalize: strip trailing slash from URL
  const baseUrl = url.replace(/\/+$/, '');
  const _fetch = customFetch || globalThis.fetch;

  // ── HTTP helper ──
  async function request(method, path, body = null, extraHeaders = {}) {
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
    };
  }

  function fromRow(row) {
    return {
      id: row.id,
      agent: row.agent_id,
      memory: row.content,
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
        linkMap.get(l.source_id).push({ id: l.target_id, similarity: l.strength });
        if (!linkMap.has(l.target_id)) linkMap.set(l.target_id, []);
        linkMap.get(l.target_id).push({ id: l.source_id, similarity: l.strength });
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
        `/rest/v1/${table}?select=id,agent_id,content,category,importance,tags,embedding,created_at,updated_at,access_count&order=created_at.asc&limit=50000`);
      const memories = (rows || []).map(fromRow);
      await loadLinks(memories);
      return memories;
    },

    async save(memories) {
      // Full save: delete all, re-insert.
      // This matches jsonStorage semantics (full overwrite).
      // For incremental ops, use upsert/delete instead.
      await request('DELETE', `/rest/v1/${table}?id=not.is.null`);
      await request('DELETE', `/rest/v1/${linksTable}?id=not.is.null`);

      if (memories.length === 0) return;

      // Batch insert memories
      for (let i = 0; i < memories.length; i += 50) {
        const batch = memories.slice(i, i + 50).map(toRow);
        await request('POST', `/rest/v1/${table}`, batch, { 'Prefer': 'return=minimal' });
      }

      // Collect and insert links (deduplicated: only store source→target where source < target)
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

    genId() {
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
    async search(embedding, { agent = null, limit = 10, minSimilarity = 0.3 } = {}) {
      try {
        const rpcName = agent ? 'search_memories_semantic' : 'search_memories_global';
        const body = agent
          ? { agent, query_embedding: JSON.stringify(embedding), match_count: limit, min_similarity: minSimilarity }
          : { query_embedding: JSON.stringify(embedding), match_count: limit, min_similarity: minSimilarity };
        const results = await request('POST', `/rest/v1/rpc/${rpcName}`, body);
        if (!results || !Array.isArray(results)) return null;
        return results.map(r => ({
          id: r.id,
          agent: r.agent_id,
          memory: r.content,
          category: r.category,
          importance: r.importance,
          tags: r.tags || [],
          created_at: r.created_at,
          updated_at: r.updated_at,
          score: r.similarity,
        }));
      } catch {
        // RPC not available — return null so caller falls back to client-side
        return null;
      }
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
      const rows = links.map(l => ({
        id: randomUUID(),
        source_id: sourceId,
        target_id: l.id,
        strength: l.similarity,
        created_at: new Date().toISOString(),
      }));
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
