import { cosineSimilarity } from './embeddings.mjs';
import { computeTrust, normalizeClaim } from './graph-utils.mjs';

function validateAgent(graph, agent, { detailed = false } = {}) {
  if (!agent || typeof agent !== 'string') throw new Error('agent must be a non-empty string');
  if (agent.length > graph.getMaxAgentLength()) throw new Error(`agent exceeds max length (${graph.getMaxAgentLength()})`);
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(agent)) {
    throw new Error(detailed
      ? 'agent contains invalid characters (alphanumeric, hyphens, underscores, dots, spaces only)'
      : 'agent contains invalid characters');
  }
}

function normalizeEventTime(eventTime, errorPrefix = 'eventTime') {
  if (eventTime === undefined) return undefined;
  if (typeof eventTime === 'string') {
    const parsed = new Date(eventTime);
    if (isNaN(parsed.getTime())) throw new Error(`${errorPrefix} must be a valid ISO 8601 date string`);
    return parsed.toISOString();
  }
  if (eventTime instanceof Date) {
    if (isNaN(eventTime.getTime())) throw new Error(`${errorPrefix} must be a valid Date`);
    return eventTime.toISOString();
  }
  throw new Error(`${errorPrefix} must be a string or Date`);
}

function validateAndNormalizeClaim(graph, claim) {
  if (claim === undefined) return { normalizedClaim: undefined, predicateSchema: null };
  if (typeof claim !== 'object' || claim === null) throw new Error('claim must be an object');
  if (typeof claim.subject !== 'string' || !claim.subject.trim() || claim.subject.length > 100) {
    throw new Error('claim.subject must be a non-empty string (max 100 chars)');
  }
  if (typeof claim.predicate !== 'string' || !claim.predicate.trim() || claim.predicate.length > 100) {
    throw new Error('claim.predicate must be a non-empty string (max 100 chars)');
  }
  if (typeof claim.value !== 'string' || claim.value.length > 1000) {
    throw new Error('claim.value must be a string (max 1000 chars)');
  }
  if (!['global', 'session', 'temporal'].includes(claim.scope)) {
    throw new Error("claim.scope must be one of 'global', 'session', or 'temporal'");
  }
  if (claim.scope === 'session' && (typeof claim.sessionId !== 'string' || !claim.sessionId.trim())) {
    throw new Error('claim.sessionId is required when claim.scope is session');
  }

  const normalizedClaimInput = {
    subject: claim.subject,
    predicate: claim.predicate,
    value: claim.value,
    exclusive: claim.exclusive !== undefined ? claim.exclusive : true,
    scope: claim.scope,
    sessionId: claim.sessionId,
    validFrom: claim.validFrom,
    validUntil: claim.validUntil,
  };
  const predicateSchema = graph.getPredicateSchemaOrDefault(normalizedClaimInput.predicate);
  return {
    predicateSchema,
    normalizedClaim: normalizeClaim(normalizedClaimInput, predicateSchema.normalize),
  };
}

async function maybeCorroborateDuplicateClaim(graph, normalizedClaim, predicateSchema) {
  if (!normalizedClaim) return null;
  const existing = graph.findExactClaimDuplicate(normalizedClaim);
  const shouldCorroborate = !!existing && (
    predicateSchema?.cardinality !== 'multi' ||
    predicateSchema?.dedupPolicy === 'corroborate'
  );
  if (!shouldCorroborate) return null;

  await graph.corroborateMemory(existing.id);
  existing.updated_at = new Date().toISOString();
  if (!(await graph.persistMemory(existing))) {
    await graph.save();
  }
  return { ...existing, deduplicated: true };
}

function ensureSingleStoreCapacity(graph) {
  if (graph.memoryCount() >= graph.getMaxMemories()) {
    throw new Error(`Memory limit reached (${graph.getMaxMemories()}). Run decay() or increase maxMemories.`);
  }
}

function ensureBatchStoreCapacity(graph, items) {
  if (graph.memoryCount() + items.length > graph.getMaxMemories()) {
    throw new Error(`Batch would exceed memory limit (${graph.getMaxMemories()}). Run decay() or increase maxMemories.`);
  }
}

async function embedSingle(graph, text) {
  const [embedding] = await graph.embeddings.embed(text);
  return embedding;
}

async function embedBatch(graph, texts, embeddingBatchSize) {
  const allEmbeddings = [];
  for (let i = 0; i < texts.length; i += embeddingBatchSize) {
    const batch = texts.slice(i, i + embeddingBatchSize);
    const embeddings = await graph.embeddings.embed(...batch);
    allEmbeddings.push(...embeddings);
  }
  return allEmbeddings;
}

function findRelatedMemories(graph, embedding, staged = []) {
  const related = [];
  if (!embedding) return related;

  for (const existing of graph.listMemories()) {
    if (!existing.embedding) continue;
    const sim = cosineSimilarity(embedding, existing.embedding);
    if (sim > graph.getLinkThreshold()) {
      related.push({ id: existing.id, similarity: sim, agent: existing.agent });
    }
  }

  for (const stagedMem of staged) {
    if (!stagedMem.embedding) continue;
    const sim = cosineSimilarity(embedding, stagedMem.embedding);
    if (sim > graph.getLinkThreshold()) {
      related.push({ id: stagedMem.id, similarity: sim, agent: stagedMem.agent });
    }
  }

  related.sort((a, b) => b.similarity - a.similarity);
  return related.slice(0, graph.getMaxLinksPerMemory());
}

function buildProvenance(provenance) {
  return provenance
    ? {
      source: provenance.source || 'inference',
      sourceId: provenance.sourceId,
      corroboration: 1,
      trust: computeTrust({ source: provenance.source || 'inference', sourceId: provenance.sourceId, corroboration: 1 }, 0, 0, 0),
    }
    : { source: 'inference', corroboration: 1, trust: 0.5 };
}

function buildMemoryRecord(graph, {
  id,
  agent,
  text,
  category = 'fact',
  importance = 0.7,
  tags = [],
  embedding,
  topLinks,
  now,
  normalizedClaim,
  eventAt,
  provenance,
  includeStatusFields = false,
}) {
  return {
    id,
    agent,
    memory: text,
    category,
    importance,
    tags: tags || [],
    embedding,
    links: topLinks.map(l => ({ id: l.id, similarity: l.similarity, type: 'similar' })),
    created_at: now,
    updated_at: now,
    ...(includeStatusFields ? {
      status: 'active',
      reinforcements: 0,
      disputes: 0,
      provenance: buildProvenance(provenance),
    } : {}),
    ...(normalizedClaim && { claim: normalizedClaim }),
    ...(eventAt !== undefined && { event_at: eventAt }),
  };
}

async function resolveSingleStoreConflicts(graph, newMem, onConflict) {
  const supersededIds = new Set();
  let pendingConflictsChanged = false;
  let pendingConflictId;
  if (!newMem.claim) return { supersededIds, pendingConflictsChanged, pendingConflictId };

  const conflicting = graph.findStructuralConflicts(newMem.claim);
  if (conflicting.length === 0) return { supersededIds, pendingConflictsChanged, pendingConflictId };

  await graph.ensurePendingConflictsLoaded();
  const claimSchema = graph.getPredicateSchemaOrDefault(newMem.claim.predicate);
  const newTrust = computeTrust(newMem.provenance, 0, 0, 0);
  newMem.provenance.trust = newTrust;

  for (const existing of conflicting) {
    const existingTrust = existing.provenance?.trust ?? 0.5;
    if (claimSchema.conflictPolicy === 'require_review') {
      if (onConflict === 'quarantine') graph.quarantineMemory(newMem, { reason: 'predicate_requires_review' });
      const pending = {
        id: graph.generateId(),
        newId: newMem.id,
        existingId: existing.id,
        newTrust,
        existingTrust,
        newClaim: newMem.claim,
        existingClaim: existing.claim,
        created_at: new Date().toISOString(),
      };
      graph.addPendingConflict(pending);
      if (!pendingConflictId) pendingConflictId = pending.id;
      pendingConflictsChanged = true;
      graph.emitMutationEvent('conflict:pending', { newId: newMem.id, existingId: existing.id, newTrust, existingTrust });
      continue;
    }

    if (claimSchema.conflictPolicy === 'keep_both') {
      newMem.status = 'active';
      existing.status = 'active';
      const nowIso = new Date().toISOString();
      newMem.updated_at = nowIso;
      existing.updated_at = nowIso;
      graph.addPendingConflict({
        id: graph.generateId(),
        newId: newMem.id,
        existingId: existing.id,
        newTrust,
        existingTrust,
        newClaim: newMem.claim,
        existingClaim: existing.claim,
        created_at: nowIso,
        resolved_at: nowIso,
        resolution: 'keep_both',
      });
      pendingConflictsChanged = true;
      continue;
    }

    if (newTrust >= existingTrust) {
      existing.status = 'superseded';
      existing.superseded_by = newMem.id;
      newMem.supersedes = newMem.supersedes || [];
      if (!newMem.supersedes.includes(existing.id)) newMem.supersedes.push(existing.id);
      if (!newMem.links.find(l => l.id === existing.id && l.type === 'supersedes')) {
        newMem.links.push({ id: existing.id, similarity: 1.0, type: 'supersedes' });
      }
      supersededIds.add(existing.id);
      graph.emitMutationEvent('supersede', { newId: newMem.id, oldId: existing.id, reason: 'trust_gated' });
    } else {
      if (onConflict === 'quarantine') graph.quarantineMemory(newMem, { reason: 'trust_insufficient' });
      const pending = {
        id: graph.generateId(),
        newId: newMem.id,
        existingId: existing.id,
        newTrust,
        existingTrust,
        newClaim: newMem.claim,
        existingClaim: existing.claim,
        created_at: new Date().toISOString(),
      };
      graph.addPendingConflict(pending);
      if (!pendingConflictId) pendingConflictId = pending.id;
      pendingConflictsChanged = true;
      graph.emitMutationEvent('conflict:pending', { newId: newMem.id, existingId: existing.id, newTrust, existingTrust });
    }
  }

  return { supersededIds, pendingConflictsChanged, pendingConflictId };
}

function attachMemoryToGraph(graph, mem) {
  graph.appendMemory(mem);
  graph.indexMemory(mem);
}

function addBacklinks(graph, sourceId, topLinks, now) {
  for (const link of topLinks) {
    const target = graph.getMemoryById(link.id);
    if (target) {
      if (!target.links) target.links = [];
      if (!target.links.find(l => l.id === sourceId)) {
        target.links.push({ id: sourceId, similarity: link.similarity, type: 'similar' });
      }
      target.updated_at = now;
    }
    graph.emitMutationEvent('link', { sourceId, targetId: link.id, similarity: link.similarity, type: 'similar' });
  }
}

async function persistSingleStore(graph, newMem, topLinks, supersededIds) {
  if (await graph.persistMemory(newMem)) {
    if (topLinks.length) {
      await graph.persistLinks(newMem.id, topLinks.map(l => ({ id: l.id, similarity: l.similarity })));
    }
    const dirtyIds = new Set(topLinks.map(l => l.id));
    for (const sid of supersededIds) dirtyIds.add(sid);
    for (const targetId of dirtyIds) {
      const target = graph.getMemoryById(targetId);
      if (target) await graph.persistMemory(target);
    }
    return;
  }
  await graph.save();
}

async function finalizeSingleStore(graph, { id, agent, text, category, importance, topLinks, newMem, pendingConflictsChanged }) {
  if (pendingConflictsChanged) await graph.persistPendingConflicts();
  await graph.appendMutationWal('store', {
    memoryId: id,
    actor: agent,
    data: { category, importance, status: newMem.status, links: topLinks.length },
  });
  graph.emitMutationEvent('store', { id, agent, content: text, category, importance, links: topLinks.length });
}

function validateBatchItems(graph, items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('items must be a non-empty array');
  if (items.length > graph.getMaxBatchSize()) throw new Error(`Batch of ${items.length} exceeds max batch size (${graph.getMaxBatchSize()})`);
  return items.map((item, i) => {
    const text = typeof item === 'string' ? item : item.text;
    if (!text || typeof text !== 'string') throw new Error(`items[${i}].text must be a non-empty string`);
    if (text.length > graph.getMaxMemoryLength()) throw new Error(`items[${i}].text exceeds max length`);
    return text;
  });
}

function stageBatchMemories(graph, agent, items, allEmbeddings, now) {
  const newMems = [];
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = typeof items[i] === 'string' ? { text: items[i] } : items[i];
    const embedding = allEmbeddings[i];
    const rawEventTime = item.eventTime;
    let eventAt = undefined;
    if (rawEventTime !== undefined) {
      const parsed = new Date(rawEventTime);
      if (isNaN(parsed.getTime())) throw new Error(`items[${i}].eventTime is not a valid date`);
      eventAt = parsed.toISOString();
    }
    const topLinks = findRelatedMemories(graph, embedding, newMems);
    const id = graph.generateId();
    const newMem = buildMemoryRecord(graph, {
      id,
      agent,
      text: item.text || items[i],
      category: item.category || 'fact',
      importance: item.importance ?? 0.7,
      tags: item.tags || [],
      embedding,
      topLinks,
      now,
      eventAt,
    });
    newMems.push(newMem);
    results.push({ id, links: topLinks.length });
  }

  return { newMems, results };
}

function attachBatchToGraph(graph, newMems, now) {
  const backlinkAdded = [];
  for (const newMem of newMems) {
    attachMemoryToGraph(graph, newMem);
    for (const link of newMem.links) {
      const target = graph.getMemoryById(link.id);
      if (target) {
        if (!target.links) target.links = [];
        if (!target.links.find(l => l.id === newMem.id)) {
          const linkEntry = { id: newMem.id, similarity: link.similarity, type: 'similar' };
          target.links.push(linkEntry);
          target.updated_at = now;
          backlinkAdded.push({ target, linkEntry });
        }
      }
    }
  }
  return backlinkAdded;
}

async function persistBatchStore(graph, newMems) {
  if (graph.isIncremental) {
    const persistedIds = [];
    try {
      for (const newMem of newMems) {
        await graph.persistMemory(newMem);
        persistedIds.push(newMem.id);
      }

      for (const newMem of newMems) {
        if (newMem.links?.length) {
          await graph.persistLinks(newMem.id, newMem.links.map(l => ({ id: l.id, similarity: l.similarity })));
        }
      }

      return { persistedIds };
    } catch (err) {
      for (const id of persistedIds.reverse()) {
        await graph.removePersistedMemory(id);
      }
      throw err;
    }
  }
  await graph.save();
  return { persistedIds: [] };
}

function rollbackBatchStore(graph, newMems, backlinkAdded) {
  const newIds = new Set(newMems.map(m => m.id));
  for (const newMem of newMems) graph.deindexMemory(newMem);
  graph.replaceMemories(graph.listMemories().filter(m => !newIds.has(m.id)));
  for (const { target, linkEntry } of backlinkAdded) {
    target.links = (target.links || []).filter(l => l !== linkEntry);
  }
}

function emitBatchStoreEvents(graph, agent, newMems, results) {
  for (let i = 0; i < newMems.length; i++) {
    const m = newMems[i];
    graph.emitMutationEvent('store', { id: m.id, agent, content: m.memory, category: m.category, importance: m.importance, links: results[i].links });
  }
}

export async function storeSingle(graph, agent, text, { category = 'fact', importance = 0.7, tags = [], eventTime, claim, provenance, quarantine = false, onConflict = 'quarantine' } = {}) {
  validateAgent(graph, agent, { detailed: true });
  if (!text || typeof text !== 'string') throw new Error('text must be a non-empty string');
  if (text.length > graph.getMaxMemoryLength()) throw new Error(`text exceeds max length (${graph.getMaxMemoryLength()})`);
  if (!['quarantine', 'keep_active'].includes(onConflict)) {
    throw new Error("onConflict must be either 'quarantine' or 'keep_active'");
  }

  const eventAt = normalizeEventTime(eventTime);
  const { normalizedClaim, predicateSchema } = validateAndNormalizeClaim(graph, claim);

  await graph.ensureInitialized();

  const deduped = await maybeCorroborateDuplicateClaim(graph, normalizedClaim, predicateSchema);
  if (deduped) return deduped;

  ensureSingleStoreCapacity(graph);
  const embedding = await embedSingle(graph, text);
  const topLinks = findRelatedMemories(graph, embedding);

  const id = graph.generateId();
  const now = new Date().toISOString();
  const newMem = buildMemoryRecord(graph, {
    id,
    agent,
    text,
    category,
    importance,
    tags,
    embedding,
    topLinks,
    now,
    normalizedClaim,
    eventAt,
    provenance,
    includeStatusFields: true,
  });

  const { supersededIds, pendingConflictsChanged, pendingConflictId } = await resolveSingleStoreConflicts(graph, newMem, onConflict);
  if (quarantine === true) graph.quarantineMemory(newMem, { reason: 'manual' });

  attachMemoryToGraph(graph, newMem);
  addBacklinks(graph, id, topLinks, now);
  await persistSingleStore(graph, newMem, topLinks, supersededIds);
  await finalizeSingleStore(graph, { id, agent, text, category, importance, topLinks, newMem, pendingConflictsChanged });

  return {
    id,
    links: topLinks.length,
    topLink: topLinks[0]
      ? `${topLinks[0].id} (${(topLinks[0].similarity * 100).toFixed(1)}%, agent: ${topLinks[0].agent})`
      : 'none',
    ...(newMem.status === 'quarantined' ? { quarantined: true } : {}),
    ...(pendingConflictId ? { pendingConflictId } : {}),
  };
}

export async function storeBatch(graph, agent, items, { embeddingBatchSize = 64 } = {}) {
  validateAgent(graph, agent);
  const texts = validateBatchItems(graph, items);

  await graph.ensureInitialized();
  ensureBatchStoreCapacity(graph, items);

  const allEmbeddings = await embedBatch(graph, texts, embeddingBatchSize);
  const now = new Date().toISOString();
  const { newMems, results } = stageBatchMemories(graph, agent, items, allEmbeddings, now);
  const backlinkAdded = attachBatchToGraph(graph, newMems, now);

  try {
    await persistBatchStore(graph, newMems);
  } catch (err) {
    rollbackBatchStore(graph, newMems, backlinkAdded);
    throw err;
  }

  emitBatchStoreEvents(graph, agent, newMems, results);
  return { total: items.length, stored: results.length, results };
}
