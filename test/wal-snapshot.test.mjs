import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryGraph } from '../src/graph.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { WAL_EVENT_VERSION, jsonlWal } from '../src/wal.mjs';
import { buildWalReplayTimeline, replayMutationSubset } from '../src/wal-replay.mjs';
import {
  WAL_SNAPSHOT_FIELDS,
  createWalSnapshot,
  replaySnapshotAndWal,
  validateWalSnapshot,
} from '../src/wal-snapshot.mjs';
import { compareLiveStateToSnapshotReplay } from '../src/wal-equivalence.mjs';

describe('WAL snapshot + equivalence', () => {
  it('creates and validates snapshot metadata shape for the replay mutation subset', () => {
    const events = [
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_a',
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:00.000Z',
        data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_b',
        op: 'reinforce',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { reinforcements: 1, accessCount: 1, importance: 0.8 },
      },
    ];

    const replay = replayMutationSubset(events);
    const snapshot = createWalSnapshot({
      state: replay,
      events,
      createdAt: '2026-01-02T00:00:00.000Z',
      source: 'test',
    });

    expect(snapshot.v).toBe(1);
    expect(snapshot.type).toBe('snapshot');
    expect(snapshot.kind).toBe('mutation-subset');
    expect(snapshot.wal.eventVersion).toBe(WAL_EVENT_VERSION);
    expect(snapshot.wal.applied).toBe(2);
    expect(snapshot.wal.cursor).toEqual({ at: '2026-01-01T00:00:01.000Z', id: 'wal_b' });
    expect(snapshot.subset.fields).toEqual([...WAL_SNAPSHOT_FIELDS]);
    expect(validateWalSnapshot(snapshot)).toBeTruthy();
  });

  it('replays only WAL events after snapshot cursor with deterministic ordering', () => {
    const allEvents = [
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_a',
        op: 'store',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:00.000Z',
        data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_b',
        op: 'reinforce',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { reinforcements: 1, accessCount: 1, importance: 0.8 },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_c',
        op: 'dispute',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:01.000Z',
        data: { disputes: 1, trust: 0.2, status: 'disputed' },
      },
      {
        v: WAL_EVENT_VERSION,
        type: 'mutation',
        id: 'wal_d',
        op: 'quarantine',
        memoryId: 'mem_1',
        actor: 'agent-1',
        at: '2026-01-01T00:00:02.000Z',
        data: { reason: 'manual', details: 'review requested', status: 'quarantined' },
      },
    ];

    const snapshotEvents = allEvents.slice(0, 2);
    const snapshotReplay = replayMutationSubset(snapshotEvents);
    const snapshot = createWalSnapshot({
      state: snapshotReplay,
      events: snapshotEvents,
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    const rebuilt = replaySnapshotAndWal(snapshot, allEvents);
    expect(rebuilt.baseApplied).toBe(2);
    expect(rebuilt.applied).toBe(4);
    expect(rebuilt.timeline.map((event) => event.id)).toEqual(['wal_c', 'wal_d']);
    expect(rebuilt.byMemoryId.mem_1.status).toBe('quarantined');
    expect(rebuilt.byMemoryId.mem_1.disputes).toBe(1);
    expect(rebuilt.byMemoryId.mem_1.reinforcements).toBe(1);
  });

  it('matches live graph subset state against rebuilt snapshot+WAL state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-snapshot-eq-'));
    try {
      const wal = jsonlWal({ dir });
      const graph = new MemoryGraph({
        storage: memoryStorage(),
        embeddings: noopEmbeddings(),
        wal,
      });

      const first = await graph.store('agent-1', 'User likes tea', { importance: 0.7 });
      await graph.reinforce(first.id, 0.2);
      await graph.dispute(first.id, { reason: 'uncertain source' });
      await graph.quarantine(first.id, { reason: 'manual', details: 'review requested' });

      const second = await graph.store('agent-1', 'Team ships daily', { importance: 0.6 });
      await graph.reinforce(second.id, 0.1);

      await graph.init();
      const { events, malformed } = await wal.read({ strict: true });
      expect(malformed).toEqual([]);

      const timeline = buildWalReplayTimeline(events);
      const split = Math.max(1, Math.floor(timeline.length / 2));
      const snapshotTimeline = timeline.slice(0, split);
      const snapshotState = replayMutationSubset(snapshotTimeline);
      const snapshot = createWalSnapshot({
        state: snapshotState,
        events: snapshotTimeline,
        createdAt: '2026-01-03T00:00:00.000Z',
      });

      const result = compareLiveStateToSnapshotReplay({
        liveMemories: graph.memories,
        snapshot,
        walEvents: timeline,
        malformed,
      });

      expect(result.comparison.equivalent).toBe(true);
      expect(result.comparison.differences).toEqual([]);
      expect(result.replay.timeline.map((event) => event.id)).toEqual(timeline.slice(split).map((event) => event.id));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
