import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/index.mjs';
import { preCompactionDump } from '../src/runtime.mjs';

function createTestMemory() {
  return createMemory({
    storage: { type: 'memory' },
    embeddings: { type: 'noop' },
  });
}

describe('preCompactionDump', () => {
  it('stores 4 takeaways and 1 snapshot for 3 decisions + 1 blocker', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: use Postgres.' },
      { role: 'assistant', content: 'Decision: ship v1 this week.' },
      { role: 'assistant', content: 'Decision: keep API stable.' },
      { role: 'tool', content: 'Blocked by missing credentials.' },
    ];

    const result = await preCompactionDump(mem, 'agent-a', turns);

    expect(result.takeaways).toBe(4);
    expect(result.ids).toHaveLength(4);
    expect(mem.memories).toHaveLength(5);
    expect(mem.memories.filter((m) => m.category === 'decision')).toHaveLength(3);
    expect(mem.memories.filter((m) => m.category === 'open_thread')).toHaveLength(1);
    expect(mem.memories.filter((m) => m.category === 'session_snapshot')).toHaveLength(1);
  });

  it('dedupes duplicate moments by normalized text and stores once', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: standardize lint rules.' },
      { role: 'user', content: '   Decision: standardize lint rules.   ' },
    ];

    const result = await preCompactionDump(mem, 'agent-a', turns);

    expect(result.takeaways).toBe(1);
    expect(result.ids).toHaveLength(1);
    expect(mem.memories).toHaveLength(2);
    expect(mem.memories.filter((m) => m.category === 'decision')).toHaveLength(1);
  });

  it('caps at maxTakeaways and keeps highest-importance moments', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'I prefer verbose logs.' },
      { role: 'assistant', content: 'TODO: write rollback plan.' },
      { role: 'assistant', content: 'Blocked by pending legal review.' },
      { role: 'assistant', content: 'Decision: migrate this quarter.' },
    ];

    const result = await preCompactionDump(mem, 'agent-a', turns, { maxTakeaways: 2 });
    const takeawayMemories = mem.memories.filter((m) => m.category !== 'session_snapshot');
    const takeawayTexts = takeawayMemories.map((m) => m.memory);

    expect(result.takeaways).toBe(2);
    expect(result.ids).toHaveLength(2);
    expect(takeawayMemories).toHaveLength(2);
    expect(takeawayTexts.some((t) => t.includes('Decision: migrate this quarter.'))).toBe(true);
    expect(takeawayTexts.some((t) => t.includes('Blocked by pending legal review.'))).toBe(true);
    expect(takeawayTexts.some((t) => t.includes('TODO: write rollback plan.'))).toBe(false);
    expect(takeawayTexts.some((t) => t.includes('I prefer verbose logs.'))).toBe(false);
  });

  it("stores snapshot with 'none' entries when no moments are detected", async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'user', content: 'The cache is warm.' },
      { role: 'assistant', content: 'Latency is stable.' },
    ];

    const result = await preCompactionDump(mem, 'agent-a', turns);
    const snapshot = mem.memories.find((m) => m.category === 'session_snapshot');

    expect(result.takeaways).toBe(0);
    expect(result.ids).toEqual([]);
    expect(mem.memories).toHaveLength(1);
    expect(snapshot).toBeTruthy();
    expect(snapshot.memory).toContain('**Decisions:** none');
    expect(snapshot.memory).toContain('**Open threads:** none');
    expect(snapshot.memory).toContain('**Commitments:** none');
    expect(snapshot.memory).toContain('**Preferences:** none');
  });

  it('includes decision and blocker texts in snapshot', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: use immutable deploys.' },
      { role: 'assistant', content: 'Blocked by release freeze.' },
    ];

    await preCompactionDump(mem, 'agent-a', turns);
    const snapshot = mem.memories.find((m) => m.category === 'session_snapshot');

    expect(snapshot).toBeTruthy();
    expect(snapshot.memory).toContain('Decision: use immutable deploys.');
    expect(snapshot.memory).toContain('Blocked by release freeze.');
  });

  it("tags all stored memories with 'trigger:pre-compaction'", async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: use canary rollout.' },
      { role: 'assistant', content: 'I prefer smaller PRs.' },
    ];

    await preCompactionDump(mem, 'agent-a', turns, {
      sessionId: 's-1',
      topicSlug: 'runtime',
      projectSlug: 'neolata',
    });

    expect(mem.memories.length).toBeGreaterThan(0);
    expect(mem.memories.every((m) => m.tags.includes('trigger:pre-compaction'))).toBe(true);
  });

  it('returns takeaway ids and count correctly, with snapshotId separate', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: add retention policy.' },
      { role: 'assistant', content: 'TODO: publish migration checklist.' },
    ];

    const result = await preCompactionDump(mem, 'agent-a', turns);
    const snapshot = mem.memories.find((m) => m.id === result.snapshotId);
    const takeawayIds = mem.memories
      .filter((m) => m.category !== 'session_snapshot')
      .map((m) => m.id);

    expect(result.takeaways).toBe(2);
    expect(result.ids).toHaveLength(2);
    expect(result.ids.every((id) => takeawayIds.includes(id))).toBe(true);
    expect(result.ids.includes(result.snapshotId)).toBe(false);
    expect(snapshot).toBeTruthy();
  });
});
