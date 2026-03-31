import { normalizeReplayState } from './wal-replay.mjs';
import { replaySnapshotAndWal } from './wal-snapshot.mjs';

function roundTrust(value) {
  return typeof value === 'number' && Number.isFinite(value) ? +value.toFixed(4) : null;
}

function normalizeLiveMemory(memory = {}) {
  const status = typeof memory.status === 'string' && memory.status ? memory.status : 'active';
  const disputes = typeof memory.disputes === 'number' ? Math.max(0, Math.trunc(memory.disputes)) : 0;
  return {
    id: memory.id,
    hasStore: true,
    status,
    category: typeof memory.category === 'string' ? memory.category : null,
    importance:
      typeof memory.importance === 'number' && Number.isFinite(memory.importance)
        ? memory.importance
        : null,
    links: Array.isArray(memory.links) ? memory.links.length : 0,
    reinforcements:
      typeof memory.reinforcements === 'number' && Number.isFinite(memory.reinforcements)
        ? Math.max(0, Math.trunc(memory.reinforcements))
        : 0,
    disputes,
    // Narrow-scope replay only carries trust via dispute events in current WAL subset.
    trust: disputes > 0 ? roundTrust(memory?.provenance?.trust) : null,
    accessCount:
      typeof memory.accessCount === 'number' && Number.isFinite(memory.accessCount)
        ? Math.max(0, Math.trunc(memory.accessCount))
        : 0,
    lastActor: typeof memory.agent === 'string' ? memory.agent : null,
    lastAt:
      typeof memory.updated_at === 'string'
        ? memory.updated_at
        : (typeof memory.created_at === 'string' ? memory.created_at : null),
    quarantine: status === 'quarantined'
      ? {
        reason: memory?.quarantine?.reason ?? null,
        details: memory?.quarantine?.details ?? null,
      }
      : null,
  };
}

export function projectLiveMutationSubsetState(memories = []) {
  if (!Array.isArray(memories)) {
    throw new Error('memories must be an array');
  }
  const byMemoryId = {};
  const ordered = [...memories]
    .filter((memory) => memory && typeof memory.id === 'string' && memory.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const memory of ordered) {
    byMemoryId[memory.id] = normalizeLiveMemory(memory);
  }
  return normalizeReplayState({ byMemoryId, applied: 0 });
}

function comparableRecord(record = {}, { includeTemporal = false } = {}) {
  return {
    id: record.id,
    hasStore: record.hasStore,
    status: record.status,
    category: record.category,
    importance: record.importance,
    links: record.links,
    reinforcements: record.reinforcements,
    disputes: record.disputes,
    trust: record.trust,
    accessCount: record.accessCount,
    lastActor: record.lastActor,
    ...(includeTemporal ? { lastAt: record.lastAt } : {}),
    quarantine: record.quarantine
      ? { reason: record.quarantine.reason ?? null, details: record.quarantine.details ?? null }
      : null,
  };
}

export function compareMutationSubsetStates(liveState, rebuiltState, { includeTemporal = false } = {}) {
  const live = normalizeReplayState(liveState);
  const rebuilt = normalizeReplayState(rebuiltState);

  const memoryIds = [...new Set([
    ...Object.keys(live.byMemoryId || {}),
    ...Object.keys(rebuilt.byMemoryId || {}),
  ])].sort();

  const differences = [];
  for (const memoryId of memoryIds) {
    const left = comparableRecord(live.byMemoryId[memoryId] || {}, { includeTemporal });
    const right = comparableRecord(rebuilt.byMemoryId[memoryId] || {}, { includeTemporal });
    const fields = Object.keys({ ...left, ...right });
    for (const field of fields) {
      const l = left[field];
      const r = right[field];
      if (JSON.stringify(l) !== JSON.stringify(r)) {
        differences.push({ memoryId, field, live: l, rebuilt: r });
      }
    }
  }

  return {
    equivalent: differences.length === 0,
    compared: memoryIds.length,
    differences,
  };
}

export function compareLiveStateToSnapshotReplay({
  liveMemories = [],
  snapshot,
  walEvents = [],
  malformed = [],
  includeTemporal = false,
} = {}) {
  const liveState = projectLiveMutationSubsetState(liveMemories);
  const rebuilt = replaySnapshotAndWal(snapshot, walEvents, { malformed });
  const rebuiltState = normalizeReplayState(rebuilt);
  const comparison = compareMutationSubsetStates(liveState, rebuiltState, { includeTemporal });

  return {
    liveState,
    rebuiltState,
    comparison,
    replay: rebuilt,
  };
}
