import { WAL_EVENT_VERSION, WAL_MUTATION_OPS } from './wal.mjs';
import {
  buildWalReplayTimeline,
  normalizeReplayState,
  replayMutationSubsetFromState,
} from './wal-replay.mjs';

export const WAL_SNAPSHOT_VERSION = 1;
export const WAL_SNAPSHOT_KIND = 'mutation-subset';
export const WAL_SNAPSHOT_FIELDS = Object.freeze([
  'id',
  'hasStore',
  'status',
  'category',
  'importance',
  'links',
  'reinforcements',
  'disputes',
  'trust',
  'accessCount',
  'lastActor',
  'lastAt',
  'quarantine.reason',
  'quarantine.details',
]);

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function ensureIso(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp string`);
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) throw new Error(`${label} must be an ISO timestamp string`);
}

function ensureStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${label} must contain non-empty strings`);
    }
  }
}

function deriveCursorFromTimeline(timeline = [], applied = 0) {
  if (applied <= 0) return null;
  if (applied > timeline.length) {
    throw new Error(`snapshot wal.applied (${applied}) exceeds provided event count (${timeline.length})`);
  }
  const event = timeline[applied - 1];
  return { at: event.at, id: event.id };
}

function compareEventToCursor(event, cursor) {
  const atDiff = new Date(event.at).getTime() - new Date(cursor.at).getTime();
  if (atDiff !== 0) return atDiff;
  return event.id.localeCompare(cursor.id);
}

export function validateWalSnapshot(snapshot) {
  ensureObject(snapshot, 'snapshot');
  if (snapshot.v !== WAL_SNAPSHOT_VERSION) {
    throw new Error(`snapshot.v must be ${WAL_SNAPSHOT_VERSION}`);
  }
  if (snapshot.type !== 'snapshot') throw new Error('snapshot.type must be "snapshot"');
  if (snapshot.kind !== WAL_SNAPSHOT_KIND) throw new Error(`snapshot.kind must be "${WAL_SNAPSHOT_KIND}"`);
  ensureIso(snapshot.createdAt, 'snapshot.createdAt');

  ensureObject(snapshot.subset, 'snapshot.subset');
  ensureStringArray(snapshot.subset.ops, 'snapshot.subset.ops');
  ensureStringArray(snapshot.subset.fields, 'snapshot.subset.fields');
  for (const op of snapshot.subset.ops) {
    if (!WAL_MUTATION_OPS.has(op)) {
      throw new Error(`snapshot.subset.ops contains unsupported op: ${op}`);
    }
  }

  ensureObject(snapshot.wal, 'snapshot.wal');
  if (snapshot.wal.eventVersion !== WAL_EVENT_VERSION) {
    throw new Error(`snapshot.wal.eventVersion must be ${WAL_EVENT_VERSION}`);
  }
  if (
    typeof snapshot.wal.applied !== 'number' ||
    !Number.isInteger(snapshot.wal.applied) ||
    snapshot.wal.applied < 0
  ) {
    throw new Error('snapshot.wal.applied must be a non-negative integer');
  }
  if (snapshot.wal.cursor !== null) {
    ensureObject(snapshot.wal.cursor, 'snapshot.wal.cursor');
    ensureIso(snapshot.wal.cursor.at, 'snapshot.wal.cursor.at');
    if (typeof snapshot.wal.cursor.id !== 'string' || !snapshot.wal.cursor.id.trim()) {
      throw new Error('snapshot.wal.cursor.id must be a non-empty string');
    }
  }

  ensureObject(snapshot.state, 'snapshot.state');
  const normalizedState = normalizeReplayState({
    byMemoryId: snapshot.state.byMemoryId || {},
    applied: snapshot.wal.applied,
  });

  if (snapshot.wal.applied === 0 && snapshot.wal.cursor !== null) {
    throw new Error('snapshot.wal.cursor must be null when snapshot.wal.applied is 0');
  }
  if (snapshot.wal.applied > 0 && snapshot.wal.cursor === null) {
    throw new Error('snapshot.wal.cursor must be set when snapshot.wal.applied is greater than 0');
  }

  return {
    ...snapshot,
    state: { byMemoryId: normalizedState.byMemoryId },
  };
}

export function createWalSnapshot({
  state = {},
  events = [],
  createdAt = new Date().toISOString(),
  source = 'live',
  applied,
  cursor,
} = {}) {
  ensureIso(createdAt, 'createdAt');
  const normalizedState = normalizeReplayState(state);
  const timeline = buildWalReplayTimeline(events);
  const appliedCount = applied ?? normalizedState.applied;
  if (typeof appliedCount !== 'number' || !Number.isInteger(appliedCount) || appliedCount < 0) {
    throw new Error('applied must be a non-negative integer');
  }
  const effectiveCursor = cursor ?? deriveCursorFromTimeline(timeline, appliedCount);
  const snapshot = {
    v: WAL_SNAPSHOT_VERSION,
    type: 'snapshot',
    kind: WAL_SNAPSHOT_KIND,
    createdAt,
    subset: {
      ops: [...WAL_MUTATION_OPS],
      fields: [...WAL_SNAPSHOT_FIELDS],
    },
    wal: {
      eventVersion: WAL_EVENT_VERSION,
      applied: appliedCount,
      cursor: effectiveCursor,
    },
    meta: {
      source: typeof source === 'string' && source ? source : 'live',
    },
    state: {
      byMemoryId: normalizedState.byMemoryId,
    },
  };
  validateWalSnapshot(snapshot);
  return snapshot;
}

export function selectWalEventsAfterSnapshot(snapshot, events = []) {
  const valid = validateWalSnapshot(snapshot);
  const timeline = buildWalReplayTimeline(events);
  const cursor = valid.wal.cursor;
  if (!cursor) return timeline;
  return timeline.filter((event) => compareEventToCursor(event, cursor) > 0);
}

export function replaySnapshotAndWal(snapshot, events = [], { malformed = [] } = {}) {
  const valid = validateWalSnapshot(snapshot);
  const tail = selectWalEventsAfterSnapshot(valid, events);
  const replay = replayMutationSubsetFromState(tail, {
    malformed,
    initialState: {
      byMemoryId: valid.state.byMemoryId,
      applied: valid.wal.applied,
    },
  });
  return {
    ...replay,
    baseApplied: valid.wal.applied,
  };
}

export function snapshotCursorMatchesReplay(snapshot, replay) {
  validateWalSnapshot(snapshot);
  const timeline = buildWalReplayTimeline(replay?.timeline || []);
  if (!snapshot.wal.cursor) return timeline.length === 0;
  return timeline.some((event) => compareEventToCursor(event, snapshot.wal.cursor) === 0);
}
