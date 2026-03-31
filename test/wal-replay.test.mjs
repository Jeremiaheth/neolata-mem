import { describe, it, expect } from 'vitest';
import { appendFile, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryGraph } from '../src/graph.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { WAL_EVENT_VERSION, jsonlWal } from '../src/wal.mjs';
import {
  buildWalReplayTimeline,
  readAndReplayWal,
  replayMutationSubset,
} from '../src/wal-replay.mjs';

describe('WAL replay primitives', () => {
  it('preserves append order when timestamps collide and seq is absent', () => {
    const events = [
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_z',
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_a',
        op: 'quarantine',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { reason: 'manual', details: 'review requested', status: 'quarantined' },
      },
    ];

    const timeline = buildWalReplayTimeline(events);
    expect(timeline.map((event) => event.id)).toEqual(['wal_z', 'wal_a']);
    expect(timeline.map((event) => event.op)).toEqual(['store', 'quarantine']);
  });

  it('uses seq to replay same-timestamp events in append order', () => {
    const events = [
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_after',
        seq: 2,
        op: 'quarantine',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { reason: 'manual', details: 'review requested', status: 'quarantined' },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_before',
        seq: 1,
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
      },
    ];

    const replay = replayMutationSubset(events);
    expect(replay.timeline.map((event) => event.id)).toEqual(['wal_before', 'wal_after']);
    expect(replay.timeline.map((event) => event.op)).toEqual(['store', 'quarantine']);
    expect(replay.byMemoryId.mem_1.status).toBe('quarantined');
  });

  it('replays legacy same-timestamp entries in file order when seq is absent', () => {
    const events = [
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_second',
        op: 'quarantine',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { reason: 'manual', details: 'review requested', status: 'quarantined' },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_first',
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
      },
    ];

    const timeline = buildWalReplayTimeline(events);
    expect(timeline.map((event) => event.id)).toEqual(['wal_second', 'wal_first']);
  });

  it('replays valid mutation subset events into deterministic scaffold state', () => {
    const events = [
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_1',
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:00.000Z',
        data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_2',
        op: 'reinforce',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { importance: 0.9, accessCount: 1, reinforcements: 1 },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_3',
        op: 'dispute',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:02.000Z',
        data: { disputes: 1, trust: 0.35, status: 'active', reason: 'uncertain source' },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_4',
        op: 'quarantine',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:03.000Z',
        data: { reason: 'manual', details: 'review requested', status: 'quarantined' },
      },
    ];

    const replay = replayMutationSubset(events);
    expect(replay.timeline.map((event) => event.op)).toEqual(['store', 'reinforce', 'dispute', 'quarantine']);
    expect(replay.malformed).toEqual([]);
    expect(replay.applied).toBe(4);
    expect(replay.byMemoryId.mem_1).toEqual({
      id: 'mem_1',
      hasStore: true,
      status: 'quarantined',
      category: 'fact',
      importance: 0.9,
      links: 0,
      reinforcements: 1,
      disputes: 1,
      trust: 0.35,
      accessCount: 1,
      lastActor: 'agent-1',
      lastAt: '2026-01-01T00:00:03.000Z',
      quarantine: {
        reason: 'manual',
        details: 'review requested',
      },
    });
  });

  it('handles malformed WAL lines during replay in strict and non-strict modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-replay-malformed-'));
    try {
      const wal = jsonlWal({ dir });
      await wal.appendMutation({
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:00.000Z',
        data: { category: 'fact', importance: 0.7, status: 'active', links: 0 },
      });
      await appendFile(wal.path, 'not-json\n', 'utf8');
      await wal.appendMutation({
        op: 'reinforce',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { importance: 0.8, accessCount: 1, reinforcements: 1 },
      });

      const replay = await readAndReplayWal({ wal, strict: false });
      expect(replay.timeline).toHaveLength(2);
      expect(replay.applied).toBe(2);
      expect(replay.byMemoryId.mem_1.reinforcements).toBe(1);
      expect(replay.malformed).toHaveLength(1);
      expect(replay.malformed[0].line).toBe(2);

      await expect(readAndReplayWal({ wal, strict: true })).rejects.toThrow('Malformed WAL entry at line 2');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches graph state for replayable mutation subset where feasible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-replay-eq-'));
    try {
      const wal = jsonlWal({ dir });
      const graph = new MemoryGraph({
        storage: memoryStorage(),
        embeddings: noopEmbeddings(),
        wal,
      });

      const stored = await graph.store('agent-1', 'User likes tea', { importance: 0.7 });
      await graph.reinforce(stored.id, 0.2);
      await graph.dispute(stored.id, { reason: 'uncertain source' });
      await graph.quarantine(stored.id, { reason: 'manual', details: 'review requested' });

      const replay = await readAndReplayWal({ wal, strict: true });
      const memory = graph._byId(stored.id);

      expect(memory).toBeTruthy();
      expect(memory.status).toBe('quarantined');
      expect(memory.quarantine?.reason).toBe('manual');
      expect(replay.byMemoryId[stored.id]).toBeTruthy();
      expect(replay.byMemoryId[stored.id].status).toBe(memory.status);
      expect(replay.byMemoryId[stored.id].reinforcements).toBe(memory.reinforcements);
      expect(replay.byMemoryId[stored.id].disputes).toBe(memory.disputes);
      expect(replay.byMemoryId[stored.id].importance).toBe(memory.importance);
      expect(replay.byMemoryId[stored.id].category).toBe(memory.category);
      expect(replay.byMemoryId[stored.id].quarantine).toEqual({
        reason: memory.quarantine?.reason ?? null,
        details: memory.quarantine?.details ?? null,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
