import { describe, it, expect } from 'vitest';
import { appendFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  WAL_EVENT_VERSION,
  createWalMutationEvent,
  jsonlWal,
} from '../src/wal.mjs';

describe('WAL primitive', () => {
  it('appends events in deterministic order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-order-'));
    try {
      const wal = jsonlWal({ dir });
      await wal.appendMutation({
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-a',
        at: '2026-01-01T00:00:00.000Z',
        data: { seq: 1 },
      });
      await wal.appendMutation({
        op: 'reinforce',
        memoryId: 'mem_1',
        actor: 'agent-a',
        at: '2026-01-01T00:00:01.000Z',
        data: { seq: 2 },
      });
      await wal.appendMutation({
        op: 'dispute',
        memoryId: 'mem_1',
        actor: 'agent-a',
        at: '2026-01-01T00:00:02.000Z',
        data: { seq: 3 },
      });

      const { events, malformed } = await wal.read();
      expect(malformed).toEqual([]);
      expect(events).toHaveLength(3);
      expect(events.map(e => e.op)).toEqual(['store', 'reinforce', 'dispute']);
      expect(events.map(e => e.data.seq)).toEqual([1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('enforces a small durable mutation event schema shape', () => {
    const event = createWalMutationEvent({
      op: 'store',
      memoryId: 'mem_abc',
      actor: 'agent-a',
      at: '2026-01-01T00:00:00.000Z',
      data: { category: 'fact', links: 0 },
    });

    expect(event.v).toBe(WAL_EVENT_VERSION);
    expect(event.type).toBe('mutation');
    expect(event.id.startsWith('wal_')).toBe(true);
    expect(event.op).toBe('store');
    expect(event.memoryId).toBe('mem_abc');
    expect(event.actor).toBe('agent-a');
    expect(event.at).toBe('2026-01-01T00:00:00.000Z');
    expect(event.data).toEqual({ category: 'fact', links: 0 });
  });

  it('handles malformed lines by skipping in non-strict mode and throwing in strict mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-malformed-'));
    try {
      const wal = jsonlWal({ dir });
      await wal.appendMutation({
        op: 'store',
        memoryId: 'mem_1',
        actor: 'a',
        at: '2026-01-01T00:00:00.000Z',
        data: { seq: 1 },
      });
      await appendFile(wal.path, 'not-json\n', 'utf8');
      await wal.appendMutation({
        op: 'reinforce',
        memoryId: 'mem_1',
        actor: 'a',
        at: '2026-01-01T00:00:01.000Z',
        data: { seq: 2 },
      });

      const read = await wal.read();
      expect(read.events).toHaveLength(2);
      expect(read.events.map(e => e.op)).toEqual(['store', 'reinforce']);
      expect(read.malformed).toHaveLength(1);
      expect(read.malformed[0].line).toBe(2);

      await expect(wal.read({ strict: true })).rejects.toThrow('Malformed WAL entry at line 2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
