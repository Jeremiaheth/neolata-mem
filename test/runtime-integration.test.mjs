import { describe, it, expect } from 'vitest';
import {
  createMemory,
  heartbeatStore,
  contextualRecall,
  preCompactionDump,
} from '../src/index.mjs';

describe('runtime integration', () => {
  it('runs heartbeat, recall, and pre-compaction workflow in one session lifecycle', async () => {
    const mem = createMemory({
      storage: { type: 'memory' },
      embeddings: { type: 'noop' },
    });

    const agent = 'test-agent';
    const sessionId = 'sess-1';
    const projectSlug = 'myproject';
    const turns = [
      { role: 'user', content: 'Decision: we will use PostgreSQL' },
      { role: 'user', content: 'I prefer dark mode' },
      { role: 'assistant', content: 'I will update the docs by Friday' },
      { role: 'assistant', content: 'Blocked by the API rate limit' },
      { role: 'user', content: 'Can you summarize the rollout plan?' },
      { role: 'assistant', content: 'Sure, I am drafting steps now.' },
      { role: 'user', content: 'Let us keep the timeline realistic.' },
      { role: 'assistant', content: 'Acknowledged, I will keep it concise.' },
    ];

    const heartbeat = await heartbeatStore(mem, agent, turns, {
      sessionId,
      projectSlug,
      minNewTurns: 3,
      lastStoredIndex: -1,
    });

    expect(heartbeat.stored).toBeGreaterThanOrEqual(4);
    expect(heartbeat.ids).toHaveLength(heartbeat.stored);

    const recall = await contextualRecall(mem, agent, 'PostgreSQL database decision', {
      maxTokens: 5000,
    });

    expect(recall.memories.length).toBeGreaterThan(0);
    expect(typeof recall.topicSlug).toBe('string');

    const compaction = await preCompactionDump(mem, agent, turns, {
      sessionId,
      projectSlug,
    });

    expect(compaction.takeaways).toBeGreaterThanOrEqual(4);
    expect(typeof compaction.snapshotId).toBe('string');

    const allMemories = await mem.search(agent, '', { limit: 100 });
    const categories = new Set(allMemories.map((m) => m.category));
    const snapshotMemory = allMemories.find((m) => m.id === compaction.snapshotId);

    expect(categories.has('decision')).toBe(true);
    expect(categories.has('preference')).toBe(true);
    expect(categories.has('commitment')).toBe(true);
    expect(categories.has('open_thread')).toBe(true);
    expect(categories.has('session_snapshot')).toBe(true);
    expect(snapshotMemory).toBeTruthy();
  });
});
