#!/usr/bin/env node
/**
 * neolata-bridge.mjs — CLI bridge for Kuro's memory via neolata-mem.
 *
 * Usage:
 *   node neolata-bridge.mjs store <agentId> <text> [--meta key=value ...]
 *   node neolata-bridge.mjs search <agentId> <query> [--limit N]
 *   node neolata-bridge.mjs recall <agentId> <query> [--limit N]  (alias for search)
 *   node neolata-bridge.mjs decay <agentId>
 *   node neolata-bridge.mjs stats <agentId>
 *   node neolata-bridge.mjs recent <agentId> [--limit N]
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY)
 */

// Use local patched neolata-mem (supabase-storage.mjs fixed for our DB schema)
import { createMemory } from '../neolata-mem/src/index.mjs';

const AGENT_ID = 'kuro';

function getMem() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    process.exit(1);
  }

  // NIM embeddings for vector search (asymmetric: passage for store, query for search)
  const nvidiaKey = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY;
  const embeddingsConfig = nvidiaKey
    ? {
        type: 'openai',
        apiKey: nvidiaKey,
        model: 'nvidia/nv-embedqa-e5-v5',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        nimInputType: true,
      }
    : { type: 'noop' };

  if (!nvidiaKey) console.error('[warn] No NVIDIA_API_KEY — falling back to keyword search');

  return createMemory({
    storage: { type: 'supabase', url, key },
    embeddings: embeddingsConfig,
    // Use OpenClaw gateway for conflict resolution (haiku is cheap & fast)
    llm: { type: 'openclaw', model: 'haiku' },
    graph: {
      decayHalfLifeDays: 60,    // Agent memories decay slower
      archiveThreshold: 0.10,
      deleteThreshold: 0.03,
    },
  });
}

function collectPositionalArgs(args, startIndex, valueFlags = new Set()) {
  const values = [];
  for (let i = startIndex; i < args.length; i++) {
    if (valueFlags.has(args[i])) {
      i++; // skip consumed flag value
      continue;
    }
    if (args[i].startsWith('--')) continue;
    values.push(args[i]);
  }
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    console.error('Usage: node neolata-bridge.mjs <store|search|decay|stats|recent> ...');
    process.exit(1);
  }

  const mem = getMem();

  switch (cmd) {
    case 'store': {
      // args[1] is agentId (positional, ignored — we use AGENT_ID), args[2+] is text + flags
      const meta = {};
      const tags = [];
      const textParts = [];
      let i = 2; // skip agentId
      while (i < args.length) {
        if (args[i] === '--meta' && args[i + 1]) {
          const [k, ...v] = args[i + 1].split('=');
          meta[k] = v.join('=');
          i += 2;
        } else if (args[i] === '--tag' && args[i + 1]) {
          tags.push(args[i + 1]);
          i += 2;
        } else if (args[i] === '--importance' && args[i + 1]) {
          meta.importance = parseFloat(args[i + 1]);
          i += 2;
        } else if (args[i] === '--category' && args[i + 1]) {
          meta.category = args[i + 1];
          i += 2;
        } else if (args[i].startsWith('--')) {
          i++; // skip unknown flags
        } else {
          textParts.push(args[i]);
          i++;
        }
      }
      const text = textParts.join(' ');
      if (!text) { console.error('No text to store'); process.exit(1); }

      // Build store options
      const opts = { ...meta };
      if (tags.length) opts.tags = tags;

      const result = await mem.store(AGENT_ID, text, Object.keys(opts).length ? opts : undefined);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'search':
    case 'recall': {
      const limitIdx = args.indexOf('--limit');
      const limit = limitIdx > -1 ? parseInt(args[limitIdx + 1], 10) : 5;
      const query = collectPositionalArgs(args, 2, new Set(['--limit'])).join(' ');
      if (!query) { console.error('No query'); process.exit(1); }

      const results = await mem.search(AGENT_ID, query, { limit });
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case 'decay': {
      await mem.decay(AGENT_ID);
      console.log('Decay applied.');
      break;
    }

    case 'stats': {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
      // Count memories
      const countRes = await fetch(
        `${url}/rest/v1/memories?select=id&agent_id=eq.${AGENT_ID}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' } }
      );
      const range = countRes.headers.get('content-range') || '0-0/0';
      const total = parseInt(range.split('/')[1], 10);
      // Count links
      const linksRes = await fetch(
        `${url}/rest/v1/memory_links?select=source_id`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' } }
      );
      const linkRange = linksRes.headers.get('content-range') || '0-0/0';
      const totalLinks = parseInt(linkRange.split('/')[1], 10);
      // Count archive
      const archRes = await fetch(
        `${url}/rest/v1/memories_archive?select=id&agent_id=eq.${AGENT_ID}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' } }
      );
      const archRange = archRes.headers.get('content-range') || '0-0/0';
      const totalArch = parseInt(archRange.split('/')[1], 10);
      console.log(`Agent: ${AGENT_ID}`);
      console.log(`Memories: ${total}`);
      console.log(`Links: ${totalLinks}`);
      console.log(`Archived: ${totalArch}`);
      break;
    }

    case 'recent': {
      const lim = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : 10;
      // Direct REST query — most reliable for recent memories
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
      const res = await fetch(
        `${url}/rest/v1/memories?select=id,agent_id,content,created_at,importance,tags,stability&agent_id=eq.${AGENT_ID}&order=created_at.desc&limit=${lim}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      const rows = await res.json();
      console.log(JSON.stringify(rows.map(r => ({
        id: r.id,
        memory: r.content,
        created_at: r.created_at,
        importance: r.importance,
        tags: r.tags,
      })), null, 2));
      break;
    }

    case 'context': {
      // Contextual recall — smart topic-aware memory retrieval
      const query = collectPositionalArgs(args, 2, new Set(['--tokens'])).join(' ');
      if (!query) { console.error('No seed text for context recall'); process.exit(1); }
      
      const { contextualRecall } = await import('../neolata-mem/src/runtime.mjs');
      const maxTokens = args.includes('--tokens') ? parseInt(args[args.indexOf('--tokens') + 1], 10) : 2000;
      
      const result = await contextualRecall(mem, AGENT_ID, query, { maxTokens });
      console.log(`Topic: ${result.topicSlug || 'general'} | ${result.memories.length} memories | ${result.totalTokens} tokens | ${result.excluded} excluded\n`);
      for (const m of result.memories) {
        const age = m.created_at ? `${Math.round((Date.now() - new Date(m.created_at).getTime()) / 86400000)}d ago` : '';
        console.log(`  [${(m.importance || 0).toFixed(1)}] ${(m.memory || m.content || '').slice(0, 120)} ${age}`);
      }
      break;
    }

    case 'evolve': {
      // Evolve — LLM-based contradiction detection + update
      const text = collectPositionalArgs(args, 2).join(' ');
      if (!text) { console.error('No text to evolve'); process.exit(1); }
      const result = await mem.evolve(AGENT_ID, text);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'optimize': {
      // Run the full optimization script
      const { execSync } = await import('child_process');
      const flags = args.slice(1).join(' ');
      execSync(`node scripts/neolata-self-optimize.mjs ${flags}`, { cwd: process.cwd(), stdio: 'inherit' });
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: store, search, recall, recent, stats, context, evolve, optimize');
      process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
