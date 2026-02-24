#!/usr/bin/env node
/**
 * neolata-mem CLI
 * Usage: npx @jeremiaheth/neolata-mem <command> [args]
 */

import { createMemory } from '../src/index.mjs';

function parseEnvConfig() {
  const opts = {};

  // Auto-detect embedding provider from env
  if (process.env.OPENAI_API_KEY) {
    opts.embeddings = { type: 'openai', apiKey: process.env.OPENAI_API_KEY, model: process.env.NEOLATA_EMBED_MODEL || 'text-embedding-3-small' };
    opts.llm = { type: 'openai', apiKey: process.env.OPENAI_API_KEY, model: process.env.NEOLATA_LLM_MODEL || 'gpt-4.1-nano' };
    opts.extraction = { type: 'llm', apiKey: process.env.OPENAI_API_KEY, model: process.env.NEOLATA_LLM_MODEL || 'gpt-4.1-nano' };
  } else if (process.env.NVIDIA_API_KEY) {
    opts.embeddings = {
      type: 'openai', apiKey: process.env.NVIDIA_API_KEY,
      model: process.env.NEOLATA_EMBED_MODEL || 'baai/bge-m3',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    };
  }

  if (process.env.NEOLATA_STORAGE_DIR) {
    opts.storage = { type: 'json', dir: process.env.NEOLATA_STORAGE_DIR };
  }

  return opts;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const mem = createMemory(parseEnvConfig());

  switch (cmd) {
    case 'store': {
      const agent = args[0];
      const text = args[1];
      const tags = args.slice(2);
      if (!agent || !text) { console.error('Usage: neolata-mem store <agent> <text> [tags...]'); process.exit(1); }
      const result = await mem.store(agent, text, { tags });
      console.log(`✅ Stored: ${result.id} (${result.links} links, top: ${result.topLink})`);
      break;
    }

    case 'search': {
      const agent = args[0];
      const query = args.slice(1).join(' ');
      if (!agent || !query) { console.error('Usage: neolata-mem search <agent> <query>'); process.exit(1); }
      const results = await mem.search(agent, query);
      for (const r of results) {
        console.log(`[${r.score.toFixed(3)}] [${r.agent}/${r.category}] ${r.memory}`);
      }
      if (!results.length) console.log('No memories found.');
      break;
    }

    case 'search-all': {
      const query = args.join(' ');
      if (!query) { console.error('Usage: neolata-mem search-all <query>'); process.exit(1); }
      const results = await mem.searchAll(query);
      for (const r of results) {
        console.log(`[${r.score.toFixed(3)}] [${r.agent}/${r.category}] ${r.memory}`);
      }
      if (!results.length) console.log('No memories found.');
      break;
    }

    case 'evolve': {
      const agent = args[0];
      const text = args.slice(1).join(' ');
      if (!agent || !text) { console.error('Usage: neolata-mem evolve <agent> <text>'); process.exit(1); }
      const result = await mem.evolve(agent, text);
      for (const action of result.actions) {
        if (action.type === 'archived') console.log(`  CONFLICT: Archived "${action.old?.slice(0, 60)}..." — ${action.reason}`);
        else if (action.type === 'updated') console.log(`  EVOLVED: "${action.old?.slice(0, 50)}..." → "${action.new?.slice(0, 50)}..."`);
        else if (action.type === 'stored') console.log(`  STORED: ${action.id} (${action.links} links)`);
      }
      break;
    }

    case 'links': {
      const memId = args[0];
      if (!memId) { console.error('Usage: neolata-mem links <memory-id>'); process.exit(1); }
      const data = await mem.links(memId);
      if (!data) { console.log('Memory not found.'); break; }
      console.log(`Memory: ${data.memory} (${data.agent})`);
      console.log(`Links (${data.links.length}):`);
      for (const l of data.links) {
        console.log(`  [${(l.similarity * 100).toFixed(1)}%] [${l.agent}/${l.category}] ${l.memory}`);
      }
      break;
    }

    case 'traverse': {
      const memId = args[0];
      const hops = parseInt(args[1]) || 2;
      if (!memId) { console.error('Usage: neolata-mem traverse <memory-id> [hops]'); process.exit(1); }
      const result = await mem.traverse(memId, hops);
      if (!result) { console.log('Memory not found.'); break; }
      console.log(`Traversal from: ${result.start.memory} (${result.start.agent})`);
      console.log(`Max hops: ${result.hops} | Reached: ${result.reached}\n`);
      let lastHop = -1;
      for (const node of result.nodes) {
        if (node.hop !== lastHop) { console.log(`--- Hop ${node.hop} ---`); lastHop = node.hop; }
        const sim = node.hop === 0 ? 'origin' : `${(node.similarity * 100).toFixed(1)}%`;
        console.log(`  [${sim}] [${node.agent}/${node.category}] ${node.memory}`);
      }
      break;
    }

    case 'clusters': {
      const minSize = parseInt(args[0]) || 3;
      const clusters = await mem.clusters(minSize);
      console.log(`Found ${clusters.length} clusters (min size: ${minSize}):\n`);
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        console.log(`Cluster ${i + 1}: ${c.size} memories | Agents: ${JSON.stringify(c.agents)} | Tags: ${c.topTags.join(', ') || '(none)'}`);
        for (const m of c.memories.slice(0, 3)) {
          console.log(`  [${m.agent}/${m.category}] ${m.memory.slice(0, 90)}`);
        }
        if (c.size > 3) console.log(`  ... and ${c.size - 3} more`);
        console.log();
      }
      break;
    }

    case 'path': {
      const [idA, idB] = args;
      if (!idA || !idB) { console.error('Usage: neolata-mem path <id-a> <id-b>'); process.exit(1); }
      const result = await mem.path(idA, idB);
      if (!result || !result.found) { console.log('No path found.'); break; }
      console.log(`Path: ${result.hops} hops\n`);
      for (let i = 0; i < result.path.length; i++) {
        const p = result.path[i];
        const pre = i === 0 ? 'START' : i === result.path.length - 1 ? 'END  ' : `  ${i}  `;
        console.log(`  ${pre} [${p.agent}/${p.category}] ${p.memory}`);
        if (i < result.path.length - 1) console.log(`    |`);
      }
      break;
    }

    case 'decay': {
      const dryRun = args.includes('--dry-run');
      const report = await mem.decay({ dryRun });
      console.log(`Decay Report${dryRun ? ' (DRY RUN)' : ''}:`);
      console.log(`  Total: ${report.total} | Healthy: ${report.healthy} | Weakening: ${report.weakening}`);
      console.log(`  Archived: ${report.archived.length} | Deleted: ${report.deleted.length} | Links cleaned: ${report.linksClean}`);
      for (const a of report.archived) console.log(`    [${a.strength}] [${a.agent}] ${a.memory}`);
      for (const d of report.deleted) console.log(`    [${d.strength}] [${d.agent}] ${d.memory}`);
      break;
    }

    case 'health': {
      const r = await mem.health();
      console.log(`=== Memory Graph Health ===\n`);
      console.log(`Memories: ${r.total} active, ${r.archivedCount} archived`);
      console.log(`By agent: ${JSON.stringify(r.byAgent)}`);
      console.log(`By category: ${JSON.stringify(r.byCategory)}`);
      console.log(`Links: ${r.totalLinks} total, ${r.crossAgentLinks} cross-agent, avg ${r.avgLinksPerMemory}/memory`);
      console.log(`Orphans: ${r.orphans}`);
      console.log(`Age: avg ${r.avgAgeDays}d, max ${r.maxAgeDays}d`);
      console.log(`Avg strength: ${r.avgStrength}`);
      console.log(`Distribution: strong=${r.distribution.strong} healthy=${r.distribution.healthy} weakening=${r.distribution.weakening} critical=${r.distribution.critical} dead=${r.distribution.dead}`);
      break;
    }

    case 'context': {
      const agent = args[0];
      const query = args.slice(1).join(' ');
      if (!agent || !query) { console.error('Usage: neolata-mem context <agent> <query>'); process.exit(1); }
      const result = await mem.context(agent, query);
      console.log(result.context);
      break;
    }

    default:
      console.log(`neolata-mem — Graph-native memory for AI agents

Commands:
  store <agent> <text> [tags...]   Store with A-MEM auto-linking
  search <agent> <query>           Semantic search (single agent)
  search-all <query>               Cross-agent search
  evolve <agent> <text>            Store with conflict resolution
  links <memory-id>                Show memory connections
  traverse <memory-id> [hops]      Multi-hop graph walk
  clusters [min-size]              Find memory clusters
  path <id-a> <id-b>               Shortest path between memories
  decay [--dry-run]                Run memory decay cycle
  health                           Full health report
  context <agent> <query>          Generate context briefing

Environment:
  OPENAI_API_KEY                   Enables embeddings + LLM features
  NVIDIA_API_KEY                   Use NVIDIA NIM for embeddings
  NEOLATA_EMBED_MODEL              Override embedding model
  NEOLATA_LLM_MODEL                Override LLM model
  NEOLATA_STORAGE_DIR              Override storage directory`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
