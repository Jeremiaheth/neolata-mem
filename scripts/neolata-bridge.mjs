#!/usr/bin/env node
/**
 * neolata-bridge.mjs — CLI bridge for Kuro's memory via neolata-mem.
 *
 * Usage:
 *   node neolata-bridge.mjs store <agentId> <text> [--meta key=value ...] [--tag value ...] [--dry-run]
 *   node neolata-bridge.mjs search <agentId> <query> [--limit N] [--dry-run]
 *   node neolata-bridge.mjs recall <agentId> <query> [--limit N] [--dry-run]  (alias for search)
 *   node neolata-bridge.mjs decay <agentId>
 *   node neolata-bridge.mjs stats <agentId>
 *   node neolata-bridge.mjs recent <agentId> [--limit N]
 *   node neolata-bridge.mjs context <agentId> <query> [--tokens N] [--dry-run]
 *   node neolata-bridge.mjs evolve <agentId> <text> [--dry-run]
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY)
 */

// Use local patched neolata-mem (supabase-storage.mjs fixed for our DB schema)
import { createMemory } from '../src/index.mjs';

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
      decayHalfLifeDays: 60, // Agent memories decay slower
      archiveThreshold: 0.10,
      deleteThreshold: 0.03,
    },
  });
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function readFlagValue(args, flag, fallback) {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return fallback;
  return args[idx + 1];
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

function parseStoreArgs(args) {
  const meta = {};
  const tags = [];
  const textParts = [];

  for (let i = 2; i < args.length; i++) {
    const token = args[i];

    if (token === '--meta') {
      const raw = args[i + 1];
      if (!raw) {
        console.error('Missing value after --meta (expected key=value)');
        process.exit(1);
      }
      const eqIdx = raw.indexOf('=');
      if (eqIdx === -1) {
        console.error(`Invalid --meta value: ${raw} (expected key=value)`);
        process.exit(1);
      }
      const key = raw.slice(0, eqIdx).trim();
      const value = raw.slice(eqIdx + 1);
      if (!key) {
        console.error(`Invalid --meta key in value: ${raw}`);
        process.exit(1);
      }
      meta[key] = value;
      i++;
      continue;
    }

    if (token === '--tag') {
      const value = args[i + 1];
      if (!value) {
        console.error('Missing value after --tag');
        process.exit(1);
      }
      tags.push(value);
      i++;
      continue;
    }

    if (token === '--importance') {
      const raw = args[i + 1];
      if (!raw) {
        console.error('Missing value after --importance');
        process.exit(1);
      }
      const parsed = parseFloat(raw);
      if (Number.isNaN(parsed)) {
        console.error(`Invalid --importance value: ${raw}`);
        process.exit(1);
      }
      meta.importance = parsed;
      i++;
      continue;
    }

    if (token === '--category') {
      const value = args[i + 1];
      if (!value) {
        console.error('Missing value after --category');
        process.exit(1);
      }
      meta.category = value;
      i++;
      continue;
    }

    if (token === '--dry-run') {
      continue;
    }

    if (token.startsWith('--')) {
      console.error(`Unknown flag: ${token}`);
      process.exit(1);
    }

    textParts.push(token);
  }

  return {
    text: textParts.join(' '),
    meta,
    tags,
  };
}

function printDryRun(payload) {
  console.log(JSON.stringify({ dryRun: true, ...payload }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dryRun = hasFlag(args, '--dry-run');

  if (!cmd) {
    console.error('Usage: node neolata-bridge.mjs <store|search|decay|stats|recent> ...');
    process.exit(1);
  }

  const mem = getMem();

  switch (cmd) {
    case 'store': {
      const { text, meta, tags } = parseStoreArgs(args);
      if (!text) {
        console.error('No text to store');
        process.exit(1);
      }

      const opts = { ...meta };
      if (tags.length) opts.tags = tags;

      if (dryRun) {
        printDryRun({
          command: 'store',
          agentId: AGENT_ID,
          text,
          options: opts,
        });
        break;
      }

      const result = await mem.store(AGENT_ID, text, Object.keys(opts).length ? opts : undefined);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'search':
    case 'recall': {
      const limit = parseInt(readFlagValue(args, '--limit', '5'), 10);
      const query = collectPositionalArgs(args, 2, new Set(['--limit'])).join(' ');
      if (!query) {
        console.error('No query');
        process.exit(1);
      }

      if (dryRun) {
        printDryRun({
          command: cmd,
          agentId: AGENT_ID,
          query,
          limit,
        });
        break;
      }

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
      const countRes = await fetch(
        `${url}/rest/v1/memories?select=id&agent_id=eq.${AGENT_ID}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' } }
      );
      const range = countRes.headers.get('content-range') || '0-0/0';
      const total = parseInt(range.split('/')[1], 10);
      const linksRes = await fetch(
        `${url}/rest/v1/memory_links?select=source_id`,
        { headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' } }
      );
      const linkRange = linksRes.headers.get('content-range') || '0-0/0';
      const totalLinks = parseInt(linkRange.split('/')[1], 10);
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
      const lim = parseInt(readFlagValue(args, '--limit', '10'), 10);
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
      const maxTokens = parseInt(readFlagValue(args, '--tokens', '2000'), 10);
      const query = collectPositionalArgs(args, 2, new Set(['--tokens'])).join(' ');
      if (!query) {
        console.error('No seed text for context recall');
        process.exit(1);
      }

      if (dryRun) {
        printDryRun({
          command: 'context',
          agentId: AGENT_ID,
          query,
          maxTokens,
        });
        break;
      }

      const { contextualRecall } = await import('../src/runtime.mjs');
      const result = await contextualRecall(mem, AGENT_ID, query, { maxTokens });
      console.log(`Topic: ${result.topicSlug || 'general'} | ${result.memories.length} memories | ${result.totalTokens} tokens | ${result.excluded} excluded\n`);
      for (const m of result.memories) {
        const age = m.created_at ? `${Math.round((Date.now() - new Date(m.created_at).getTime()) / 86400000)}d ago` : '';
        console.log(`  [${(m.importance || 0).toFixed(1)}] ${(m.memory || m.content || '').slice(0, 120)} ${age}`);
      }
      break;
    }

    case 'evolve': {
      const text = collectPositionalArgs(args, 2).join(' ');
      if (!text) {
        console.error('No text to evolve');
        process.exit(1);
      }

      if (dryRun) {
        printDryRun({
          command: 'evolve',
          agentId: AGENT_ID,
          text,
        });
        break;
      }

      const result = await mem.evolve(AGENT_ID, text);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'optimize': {
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

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
