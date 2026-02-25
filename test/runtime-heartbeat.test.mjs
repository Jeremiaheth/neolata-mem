import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/index.mjs';
import { heartbeatStore } from '../src/runtime.mjs';

function createTestMemory() {
  return createMemory({
    storage: { type: 'memory' },
    embeddings: { type: 'noop' },
  });
}

describe('heartbeatStore', () => {
  it('stores decision memory from 3 turns and returns stored=1', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'user', content: 'Can we finalize this?' },
      { role: 'assistant', content: 'Yes, we are aligned now.' },
      { role: 'assistant', content: 'Decision: ship v1 this week.' },
    ];

    const result = await heartbeatStore(mem, 'agent-a', turns);

    expect(result.stored).toBe(1);
    expect(result.ids).toHaveLength(1);
    expect(result.moments).toHaveLength(1);
    expect(mem.memories).toHaveLength(1);
    expect(mem.memories[0].category).toBe('decision');
  });

  it('skips when fewer than minNewTurns', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const result = await heartbeatStore(mem, 'agent-a', turns);

    expect(result).toEqual({
      stored: 0,
      skipped: 'insufficient_turns',
      lastIndex: -1,
    });
    expect(mem.memories).toHaveLength(0);
  });

  it('stores a session_snapshot when no key moments are detected', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'user', content: 'The status page is open.' },
      { role: 'assistant', content: 'I am checking logs now.' },
      { role: 'tool', content: 'No severe alerts found.' },
    ];

    const result = await heartbeatStore(mem, 'agent-a', turns);

    expect(result.stored).toBe(1);
    expect(result.moments).toEqual([]);
    expect(mem.memories).toHaveLength(1);
    expect(mem.memories[0].category).toBe('session_snapshot');
    expect(mem.memories[0].importance).toBe(0.5);
    expect(mem.memories[0].memory.length).toBeLessThanOrEqual(500);
  });

  it('stores multiple moments across turns', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: use Postgres for persistence.' },
      { role: 'user', content: 'I prefer terse commit messages.' },
      { role: 'tool', content: 'Blocked by missing API token.' },
    ];

    const result = await heartbeatStore(mem, 'agent-a', turns);

    expect(result.stored).toBe(3);
    expect(result.ids).toHaveLength(3);
    expect(result.moments.map((m) => m.type)).toEqual(['decision', 'preference', 'blocker']);
    expect(mem.memories).toHaveLength(3);
    expect(mem.memories.map((m) => m.category)).toEqual(['decision', 'preference', 'open_thread']);
  });

  it('includes session/topic/project tags when provided', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'Decision: adopt feature flags.' },
      { role: 'assistant', content: 'No extra context.' },
      { role: 'assistant', content: 'Still continuing.' },
    ];

    await heartbeatStore(mem, 'agent-a', turns, {
      sessionId: 's123',
      topicSlug: 'runtime',
      projectSlug: 'neolata',
    });

    expect(mem.memories).toHaveLength(1);
    expect(mem.memories[0].tags).toContain('session:s123');
    expect(mem.memories[0].tags).toContain('topic:runtime');
    expect(mem.memories[0].tags).toContain('project:neolata');
  });

  it('processes only turns after lastStoredIndex', async () => {
    const mem = createTestMemory();
    const turns = Array.from({ length: 10 }, (_, idx) => {
      if (idx < 6) return { role: 'assistant', content: `Decision: old-${idx}` };
      return { role: 'assistant', content: `Decision: new-${idx}` };
    });

    const result = await heartbeatStore(mem, 'agent-a', turns, { lastStoredIndex: 5 });

    expect(result.stored).toBe(4);
    expect(mem.memories).toHaveLength(4);
    expect(mem.memories.every((m) => m.memory.includes('new-'))).toBe(true);
    expect(mem.memories.some((m) => m.memory.includes('old-'))).toBe(false);
  });

  it('maps provenance source based on turn role', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'user', content: 'Decision: user made this call.' },
      { role: 'assistant', content: 'Decision: assistant made this call.' },
      { role: 'tool', content: 'Decision: tool observed this call.' },
    ];

    await heartbeatStore(mem, 'agent-a', turns);

    const userMem = mem.memories.find((m) => m.memory.includes('user made this call'));
    const assistantMem = mem.memories.find((m) => m.memory.includes('assistant made this call'));
    const toolMem = mem.memories.find((m) => m.memory.includes('tool observed this call'));

    expect(userMem.provenance.source).toBe('user_explicit');
    expect(assistantMem.provenance.source).toBe('system');
    expect(toolMem.provenance.source).toBe('system');
  });

  it('returns lastIndex as the index of the last processed turn', async () => {
    const mem = createTestMemory();
    const turns = [
      { role: 'assistant', content: 'No key moment 0' },
      { role: 'assistant', content: 'No key moment 1' },
      { role: 'assistant', content: 'No key moment 2' },
      { role: 'assistant', content: 'Decision: process this one.' },
      { role: 'assistant', content: 'Decision: and this one too.' },
    ];

    const result = await heartbeatStore(mem, 'agent-a', turns, {
      lastStoredIndex: 2,
      minNewTurns: 2,
    });

    expect(result.lastIndex).toBe(4);
    expect(result.stored).toBe(2);
  });
});
