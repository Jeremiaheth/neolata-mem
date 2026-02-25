You are implementing neolata-mem v0.6.0. Prompts 1-13 are ALREADY DONE. Execute ONLY prompts 14 and 15.

## Prompt 14: Integration Test

Create a new file `test/v060-integration.test.mjs` with the following content exactly:

```js
import { describe, it, expect } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';

function fakeEmbeddings() {
  return {
    name: 'fake', model: 'fake',
    async embed(texts) {
      const input = Array.isArray(texts) ? texts : [texts];
      return input.map(t => {
        const vec = new Array(64).fill(0);
        for (let i = 0; i < t.length; i++) vec[i % 64] += t.charCodeAt(i) / 1000;
        const mag = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
        return vec.map(v => v / (mag || 1));
      });
    },
  };
}

function mockLLM(response) {
  return { name: 'mock-llm', async chat() { return JSON.stringify(response); } };
}

describe('v0.6.0 Integration', () => {
  it('full lifecycle: store typed links evolve supersedes search temporal reinforce SM-2 decay', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      llm: mockLLM({ conflicts: [{ index: 0, reason: 'version updated' }], updates: [], novel: true }),
      config: { linkThreshold: 0.1, initialStability: 1.0, stabilityGrowth: 2.0 },
    });
    const r1 = await graph.store('agent-1', 'Server runs on port 3000', { eventTime: '2026-01-15T00:00:00Z', category: 'fact' });
    expect(r1.id).toBeTruthy();
    const mem1 = graph.memories.find(m => m.id === r1.id);
    expect(mem1.event_at).toBe('2026-01-15T00:00:00.000Z');
    const r2 = await graph.store('agent-1', 'Server uses port 3000 for the API', { eventTime: '2026-01-16T00:00:00Z' });
    const mem2 = graph.memories.find(m => m.id === r2.id);
    if (mem2.links.length > 0) expect(mem2.links[0].type).toBe('similar');
    const janResults = await graph.search('agent-1', 'server port', { after: '2026-01-01', before: '2026-01-31' });
    expect(janResults.length).toBe(2);
    const evolved = await graph.evolve('agent-1', 'Server now runs on port 8080', { category: 'fact' });
    expect(evolved.actions.some(a => a.type === 'archived')).toBe(true);
    if (evolved.id) {
      const newMem = graph.memories.find(m => m.id === evolved.id);
      if (newMem) {
        const supersedesLinks = newMem.links.filter(l => l.type === 'supersedes');
        expect(supersedesLinks.length).toBeGreaterThan(0);
      }
      await graph.reinforce(evolved.id);
      const reinforced = graph.memories.find(m => m.id === evolved.id);
      expect(reinforced.stability).toBeDefined();
      const strength = graph.calcStrength(reinforced);
      expect(strength.mode).toBe('sm2');
    }
    const health = await graph.health();
    expect(health.total).toBeGreaterThan(0);
    expect('memoriesWithSM2' in health).toBe(true);
  });

  it('backward compatibility: old-format memories work correctly', async () => {
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: fakeEmbeddings(),
      config: { linkThreshold: 0.1 },
    });
    const now = new Date().toISOString();
    graph.memories = [
      { id: 'mem_legacy-1', agent: 'a', memory: 'old memory one', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_legacy-2', similarity: 0.8 }], created_at: now, updated_at: now },
      { id: 'mem_legacy-2', agent: 'a', memory: 'old memory two', category: 'fact', importance: 0.7, tags: [], embedding: null, links: [{ id: 'mem_legacy-1', similarity: 0.8 }], created_at: now, updated_at: now },
    ];
    graph.loaded = true;
    graph._rebuildIndexes();
    const links = await graph.links('mem_legacy-1');
    expect(links.links[0].type).toBe('similar');
    const strength = graph.calcStrength(graph.memories[0]);
    expect(strength.mode).toBe('legacy');
    const tl = await graph.timeline('a', 1);
    expect(tl.total).toBe(2);
    const results = await graph.search('a', 'old memory');
    expect(results.length).toBe(2);
    await graph.reinforce('mem_legacy-1');
    const mem = graph.memories.find(m => m.id === 'mem_legacy-1');
    expect(mem.stability).toBeDefined();
    expect(graph.calcStrength(mem).mode).toBe('sm2');
  });
});
```

Run `npx vitest run` and confirm ALL tests pass.

## Prompt 15: Version Bump

In `package.json`, change the version to `"0.6.0"`.

Run `npx vitest run` one final time to confirm everything passes.

When completely finished, run: openclaw system event --text "Done: Prompts 14-15 complete - integration tests passing, version bumped to 0.6.0" --mode now
