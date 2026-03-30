import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryGraph } from '../src/graph.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { buildWalReplayTimeline, readAndReplayWal, replayMutationSubset } from '../src/wal-replay.mjs';
import { compareLiveStateToSnapshotReplay } from '../src/wal-equivalence.mjs';
import { createWalSnapshot, replaySnapshotAndWal } from '../src/wal-snapshot.mjs';
import {
  WAL_EVENT_VERSION,
  createWalMutationEvent,
  jsonlWal,
} from '../src/wal.mjs';

async function testWalPrimitiveOrder() {
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
    assert.deepEqual(malformed, []);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.op), ['store', 'reinforce', 'dispute']);
    assert.deepEqual(events.map((event) => event.data.seq), [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testWalEventShape() {
  const event = createWalMutationEvent({
    op: 'store',
    memoryId: 'mem_abc',
    actor: 'agent-a',
    at: '2026-01-01T00:00:00.000Z',
    data: { category: 'fact', links: 0 },
  });

  assert.equal(event.v, WAL_EVENT_VERSION);
  assert.equal(event.type, 'mutation');
  assert.equal(event.id.startsWith('wal_'), true);
  assert.equal(event.op, 'store');
  assert.equal(event.memoryId, 'mem_abc');
  assert.equal(event.actor, 'agent-a');
  assert.equal(event.at, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(event.data, { category: 'fact', links: 0 });
}

async function testWalMalformedHandling() {
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
    assert.equal(read.events.length, 2);
    assert.deepEqual(read.events.map((event) => event.op), ['store', 'reinforce']);
    assert.equal(read.malformed.length, 1);
    assert.equal(read.malformed[0].line, 2);

    let strictError;
    try {
      await wal.read({ strict: true });
    } catch (error) {
      strictError = error;
    }

    assert.ok(strictError instanceof Error);
    assert.match(strictError.message, /Malformed WAL entry at line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testWalIntegrationOrder() {
  const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-int-'));
  try {
    const wal = jsonlWal({ dir });
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: noopEmbeddings(),
      wal,
    });

    const stored = await graph.store('agent-1', 'User likes tea');
    await graph.reinforce(stored.id, 0.2);
    await graph.dispute(stored.id, { reason: 'uncertain source' });
    await graph.quarantine(stored.id, { reason: 'manual', details: 'review requested' });

    const { events, malformed } = await wal.read();
    assert.deepEqual(malformed, []);
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((event) => event.op), ['store', 'reinforce', 'dispute', 'quarantine']);
    assert.deepEqual(new Set(events.map((event) => event.memoryId)), new Set([stored.id]));

    for (const event of events) {
      assert.equal(event.v, WAL_EVENT_VERSION);
      assert.equal(event.type, 'mutation');
      assert.equal(typeof event.id, 'string');
      assert.ok(event.id.length > 4);
      assert.equal(event.actor, 'agent-1');
      assert.equal(typeof event.at, 'string');
      assert.ok(event.data && typeof event.data === 'object');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testWalReplayDeterministicOrdering() {
  const timeline = buildWalReplayTimeline([
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_c',
      op: 'dispute',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:02.000Z',
      data: { disputes: 1 },
    },
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_b',
      op: 'reinforce',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:01.000Z',
      data: { reinforcements: 1 },
    },
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_a',
      op: 'store',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:01.000Z',
      data: { category: 'fact', importance: 0.7, status: 'active', links: 0 },
    },
  ]);

  assert.deepEqual(timeline.map((event) => event.id), ['wal_a', 'wal_b', 'wal_c']);
}

async function testWalReplayScaffold() {
  const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-replay-'));
  try {
    const wal = jsonlWal({ dir });
    await wal.appendMutation({
      op: 'store',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:00.000Z',
      data: { category: 'fact', importance: 0.7, status: 'active', links: 0 },
    });
    await wal.appendMutation({
      op: 'reinforce',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:01.000Z',
      data: { importance: 0.9, accessCount: 1, reinforcements: 1 },
    });
    await wal.appendMutation({
      op: 'dispute',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:02.000Z',
      data: { disputes: 1, trust: 0.35, status: 'active' },
    });
    await wal.appendMutation({
      op: 'quarantine',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:03.000Z',
      data: { reason: 'manual', details: 'review requested', status: 'quarantined' },
    });

    const replay = await readAndReplayWal({ wal, strict: true });
    assert.equal(replay.applied, 4);
    assert.equal(replay.byMemoryId.mem_1.status, 'quarantined');
    assert.equal(replay.byMemoryId.mem_1.reinforcements, 1);
    assert.equal(replay.byMemoryId.mem_1.disputes, 1);
    assert.equal(replay.byMemoryId.mem_1.importance, 0.9);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testWalSnapshotMetadataShape() {
  const events = [
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_a',
      op: 'store',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:00.000Z',
      data: { category: 'fact', importance: 0.7, status: 'active', links: 0 },
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
    source: 'validate-script',
  });

  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.kind, 'mutation-subset');
  assert.equal(snapshot.wal.eventVersion, WAL_EVENT_VERSION);
  assert.equal(snapshot.wal.applied, 2);
  assert.deepEqual(snapshot.wal.cursor, {
    at: '2026-01-01T00:00:01.000Z',
    id: 'wal_b',
  });
}

function testWalSnapshotReplayOrdering() {
  const allEvents = [
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_a',
      op: 'store',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:00.000Z',
      data: { category: 'fact', importance: 0.7, status: 'active', links: 0 },
    },
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_b',
      op: 'reinforce',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:01.000Z',
      data: { reinforcements: 1, accessCount: 1, importance: 0.9 },
    },
    {
      v: WAL_EVENT_VERSION,
      type: 'mutation',
      id: 'wal_c',
      op: 'dispute',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:01.000Z',
      data: { disputes: 1, trust: 0.35, status: 'active' },
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
  const snapshot = createWalSnapshot({
    state: replayMutationSubset(snapshotEvents),
    events: snapshotEvents,
    createdAt: '2026-01-02T00:00:00.000Z',
  });

  const rebuilt = replaySnapshotAndWal(snapshot, allEvents);
  assert.equal(rebuilt.baseApplied, 2);
  assert.equal(rebuilt.applied, 4);
  assert.deepEqual(rebuilt.timeline.map((event) => event.id), ['wal_c', 'wal_d']);
}

async function testWalSnapshotEquivalence() {
  const dir = await mkdtemp(join(tmpdir(), 'neolata-wal-snapshot-equivalence-'));
  try {
    const wal = jsonlWal({ dir });
    const graph = new MemoryGraph({
      storage: memoryStorage(),
      embeddings: noopEmbeddings(),
      wal,
    });

    const first = await graph.store('agent-1', 'User likes tea');
    await graph.reinforce(first.id, 0.2);
    await graph.dispute(first.id, { reason: 'uncertain source' });
    await graph.quarantine(first.id, { reason: 'manual', details: 'review requested' });

    const second = await graph.store('agent-1', 'Team ships daily');
    await graph.reinforce(second.id, 0.1);

    const { events, malformed } = await wal.read({ strict: true });
    const timeline = buildWalReplayTimeline(events);
    const split = Math.max(1, Math.floor(timeline.length / 2));
    const snapshotTimeline = timeline.slice(0, split);
    const snapshot = createWalSnapshot({
      state: replayMutationSubset(snapshotTimeline),
      events: snapshotTimeline,
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    const result = compareLiveStateToSnapshotReplay({
      liveMemories: graph.memories,
      snapshot,
      walEvents: timeline,
      malformed,
    });

    assert.equal(result.comparison.equivalent, true);
    assert.equal(result.comparison.differences.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const checks = [
    { name: 'WAL primitive order', run: testWalPrimitiveOrder },
    { name: 'WAL event shape', run: testWalEventShape },
    { name: 'WAL malformed handling', run: testWalMalformedHandling },
    { name: 'WAL integration order', run: testWalIntegrationOrder },
    { name: 'WAL replay deterministic ordering', run: testWalReplayDeterministicOrdering },
    { name: 'WAL replay scaffold', run: testWalReplayScaffold },
    { name: 'WAL snapshot metadata shape', run: testWalSnapshotMetadataShape },
    { name: 'WAL snapshot + WAL replay ordering', run: testWalSnapshotReplayOrdering },
    { name: 'WAL snapshot equivalence', run: testWalSnapshotEquivalence },
  ];

  for (const check of checks) {
    await check.run();
    console.log(`PASS ${check.name}`);
  }

  console.log('WAL validation complete.');
}

main().catch((error) => {
  console.error('WAL validation failed.');
  if (error instanceof Error) {
    console.error(error.stack || error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
