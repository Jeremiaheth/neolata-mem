import { validateWalMutationEvent } from './wal.mjs';

function asIsoTime(value) {
  return new Date(value).getTime();
}

export function compareReplayEvents(a, b) {
  const atDiff = asIsoTime(a.at) - asIsoTime(b.at);
  if (atDiff !== 0) return atDiff;
  if (a.id !== b.id) return a.id.localeCompare(b.id);
  if (a.memoryId !== b.memoryId) return a.memoryId.localeCompare(b.memoryId);
  if (a.op !== b.op) return a.op.localeCompare(b.op);
  return 0;
}

export function normalizeReplayMemoryRecord(record = {}, memoryId = '') {
  const trust =
    typeof record.trust === 'number' && Number.isFinite(record.trust)
      ? +record.trust.toFixed(4)
      : null;
  const importance =
    typeof record.importance === 'number' && Number.isFinite(record.importance)
      ? record.importance
      : null;
  const links =
    typeof record.links === 'number' && Number.isFinite(record.links)
      ? Math.max(0, Math.trunc(record.links))
      : 0;
  const reinforcements =
    typeof record.reinforcements === 'number' && Number.isFinite(record.reinforcements)
      ? Math.max(0, Math.trunc(record.reinforcements))
      : 0;
  const disputes =
    typeof record.disputes === 'number' && Number.isFinite(record.disputes)
      ? Math.max(0, Math.trunc(record.disputes))
      : 0;
  const accessCount =
    typeof record.accessCount === 'number' && Number.isFinite(record.accessCount)
      ? Math.max(0, Math.trunc(record.accessCount))
      : 0;

  return {
    id: typeof record.id === 'string' && record.id ? record.id : memoryId,
    hasStore: record.hasStore === true,
    status: typeof record.status === 'string' && record.status ? record.status : 'unknown',
    category: typeof record.category === 'string' ? record.category : null,
    importance,
    links,
    reinforcements,
    disputes,
    trust,
    accessCount,
    lastActor: typeof record.lastActor === 'string' ? record.lastActor : null,
    lastAt: typeof record.lastAt === 'string' ? record.lastAt : null,
    quarantine: record.quarantine && typeof record.quarantine === 'object'
      ? {
        reason: record.quarantine.reason ?? null,
        details: record.quarantine.details ?? null,
      }
      : null,
  };
}

export function normalizeReplayState(state = {}) {
  const byMemoryId = {};
  for (const [memoryId, record] of Object.entries(state.byMemoryId || {})) {
    byMemoryId[memoryId] = normalizeReplayMemoryRecord(record, memoryId);
  }
  const applied =
    typeof state.applied === 'number' && Number.isInteger(state.applied) && state.applied >= 0
      ? state.applied
      : 0;
  return {
    byMemoryId,
    applied,
  };
}

function ensureReplayMemory(state, memoryId) {
  if (!state.byMemoryId[memoryId]) {
    state.byMemoryId[memoryId] = {
      id: memoryId,
      hasStore: false,
      status: 'unknown',
      category: null,
      importance: null,
      links: 0,
      reinforcements: 0,
      disputes: 0,
      trust: null,
      accessCount: 0,
      lastActor: null,
      lastAt: null,
      quarantine: null,
    };
  }
  return state.byMemoryId[memoryId];
}

function applyStore(mem, event) {
  const data = event.data || {};
  mem.hasStore = true;
  mem.category = data.category ?? mem.category;
  if (typeof data.importance === 'number') mem.importance = data.importance;
  if (typeof data.links === 'number') mem.links = data.links;
  mem.status = typeof data.status === 'string' ? data.status : (mem.status === 'unknown' ? 'active' : mem.status);
  mem.quarantine = mem.status === 'quarantined' ? mem.quarantine : null;
}

function applyReinforce(mem, event) {
  const data = event.data || {};
  if (typeof data.reinforcements === 'number') mem.reinforcements = data.reinforcements;
  else mem.reinforcements += 1;
  if (typeof data.accessCount === 'number') mem.accessCount = data.accessCount;
  if (typeof data.importance === 'number') mem.importance = data.importance;
}

function applyDispute(mem, event) {
  const data = event.data || {};
  if (typeof data.disputes === 'number') mem.disputes = data.disputes;
  else mem.disputes += 1;
  if (typeof data.trust === 'number') mem.trust = data.trust;
  if (typeof data.status === 'string') mem.status = data.status;
}

function applyQuarantine(mem, event) {
  const data = event.data || {};
  mem.status = typeof data.status === 'string' ? data.status : 'quarantined';
  mem.quarantine = {
    reason: data.reason ?? null,
    details: data.details ?? null,
  };
}

function applyMutationEvent(state, event) {
  const mem = ensureReplayMemory(state, event.memoryId);

  if (event.op === 'store') applyStore(mem, event);
  else if (event.op === 'reinforce') applyReinforce(mem, event);
  else if (event.op === 'dispute') applyDispute(mem, event);
  else if (event.op === 'quarantine') applyQuarantine(mem, event);
  else throw new Error(`Unsupported replay op: ${event.op}`);

  mem.lastActor = event.actor;
  mem.lastAt = event.at;
  state.applied += 1;
}

export function buildWalReplayTimeline(events = []) {
  const replayable = [];
  for (const event of events) {
    validateWalMutationEvent(event);
    replayable.push(event);
  }
  return [...replayable].sort(compareReplayEvents);
}

export function replayMutationSubset(events = [], { malformed = [] } = {}) {
  return replayMutationSubsetFromState(events, { malformed });
}

export function replayMutationSubsetFromState(events = [], { malformed = [], initialState = null } = {}) {
  const timeline = buildWalReplayTimeline(events);
  const baseline = initialState ? normalizeReplayState(initialState) : { byMemoryId: {}, applied: 0 };
  const state = {
    timeline,
    malformed,
    applied: baseline.applied,
    byMemoryId: baseline.byMemoryId,
  };

  for (const event of timeline) {
    applyMutationEvent(state, event);
  }

  return state;
}

export async function readAndReplayWal({ wal, strict = false } = {}) {
  if (!wal || typeof wal.read !== 'function') {
    throw new Error('wal backend must implement read()');
  }

  const { events, malformed } = await wal.read({ strict: false });
  if (strict && malformed.length > 0) {
    const issue = malformed[0];
    throw new Error(`Malformed WAL entry at line ${issue.line}: ${issue.message}`);
  }

  return replayMutationSubsetFromState(events, { malformed });
}
