import { existsSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { jsonlWal } from './wal.mjs';
import { replayMutationSubset } from './wal-replay.mjs';
import { compareMutationSubsetStates, projectLiveMutationSubsetState } from './wal-equivalence.mjs';
import { replaySnapshotAndWal, validateWalSnapshot } from './wal-snapshot.mjs';

export const WAL_RECOVERY_MANIFEST_VERSION = 1;

const DEFAULT_DIR = () => join(process.cwd(), 'neolata-mem-data');

const LOCAL_ARTIFACTS = Object.freeze([
  {
    name: 'graph',
    filename: 'graph.json',
    kind: 'json-array',
    role: 'primary-local-state',
    required: false,
  },
  {
    name: 'archive',
    filename: 'archived.json',
    kind: 'json-array',
    role: 'archived-memories',
    required: false,
  },
  {
    name: 'episodes',
    filename: 'episodes.json',
    kind: 'json-array',
    role: 'episode-data',
    required: false,
  },
  {
    name: 'clusters',
    filename: 'clusters.json',
    kind: 'json-array',
    role: 'cluster-labels',
    required: false,
  },
  {
    name: 'pendingConflicts',
    filename: 'pending-conflicts.json',
    kind: 'json-array',
    role: 'conflict-review-queue',
    required: false,
  },
  {
    name: 'wal',
    filename: 'mutations.wal',
    kind: 'wal-jsonl',
    role: 'durable-mutation-log',
    required: false,
  },
  {
    name: 'snapshot',
    filename: 'wal-snapshot.json',
    kind: 'wal-snapshot',
    role: 'wal-replay-checkpoint',
    required: false,
  },
]);

function safeIsoFromStat(stats) {
  if (!stats || !(stats.mtime instanceof Date)) return null;
  return stats.mtime.toISOString();
}

function parseJsonFile(raw, filename) {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${filename} contains invalid JSON: ${message}`);
  }
}

async function describeFile(path, { includeHashes = true } = {}) {
  const present = existsSync(path);
  if (!present) {
    return {
      exists: false,
      sizeBytes: 0,
      modifiedAt: null,
      sha256: null,
    };
  }

  const [stats, bytes] = await Promise.all([
    stat(path),
    includeHashes ? readFile(path) : Promise.resolve(null),
  ]);

  return {
    exists: true,
    sizeBytes: stats.size,
    modifiedAt: safeIsoFromStat(stats),
    sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
  };
}

function makeIssue({ severity = 'error', code, artifact, message }) {
  return { severity, code, artifact, message };
}

async function readJsonArrayArtifact(path, filename) {
  const raw = await readFile(path, 'utf8');
  const parsed = parseJsonFile(raw, filename);
  if (!Array.isArray(parsed)) {
    throw new Error(`${filename} must be a JSON array`);
  }
  return parsed;
}

async function readSnapshotArtifact(path) {
  const raw = await readFile(path, 'utf8');
  const parsed = parseJsonFile(raw, 'wal-snapshot.json');
  return validateWalSnapshot(parsed);
}

async function inspectArtifact(spec, path) {
  if (!existsSync(path)) {
    return {
      name: spec.name,
      path,
      kind: spec.kind,
      role: spec.role,
      exists: false,
      status: 'missing',
      parseOk: false,
      details: {},
    };
  }

  if (spec.kind === 'json-array') {
    const parsed = await readJsonArrayArtifact(path, spec.filename);
    return {
      name: spec.name,
      path,
      kind: spec.kind,
      role: spec.role,
      exists: true,
      status: 'ok',
      parseOk: true,
      details: {
        itemCount: parsed.length,
      },
      parsed,
    };
  }

  if (spec.kind === 'wal-jsonl') {
    const wal = jsonlWal({ dir: resolve(path, '..'), filename: spec.filename });
    const { events, malformed } = await wal.read({ strict: false });
    return {
      name: spec.name,
      path,
      kind: spec.kind,
      role: spec.role,
      exists: true,
      status: malformed.length > 0 ? 'error' : 'ok',
      parseOk: malformed.length === 0,
      details: {
        eventCount: events.length,
        malformedCount: malformed.length,
        malformed,
      },
      events,
      malformed,
    };
  }

  if (spec.kind === 'wal-snapshot') {
    const snapshot = await readSnapshotArtifact(path);
    return {
      name: spec.name,
      path,
      kind: spec.kind,
      role: spec.role,
      exists: true,
      status: 'ok',
      parseOk: true,
      details: {
        applied: snapshot.wal.applied,
        cursor: snapshot.wal.cursor,
      },
      snapshot,
    };
  }

  return {
    name: spec.name,
    path,
    kind: spec.kind,
    role: spec.role,
    exists: true,
    status: 'unknown',
    parseOk: false,
    details: {},
  };
}

function summarizeStatus(issues) {
  const hasError = issues.some((issue) => issue.severity === 'error');
  if (hasError) return 'error';
  return issues.length > 0 ? 'degraded' : 'ok';
}

export async function buildLocalArtifactManifest({ dir, includeHashes = true } = {}) {
  const baseDir = resolve(dir || DEFAULT_DIR());
  const artifacts = [];

  for (const spec of LOCAL_ARTIFACTS) {
    const path = join(baseDir, spec.filename);
    const file = await describeFile(path, { includeHashes });
    artifacts.push({
      name: spec.name,
      role: spec.role,
      kind: spec.kind,
      required: spec.required,
      path,
      ...file,
    });
  }

  const existingArtifacts = artifacts.filter((artifact) => artifact.exists);
  return {
    v: WAL_RECOVERY_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    baseDir,
    artifactCount: artifacts.length,
    existingCount: existingArtifacts.length,
    missingCount: artifacts.length - existingArtifacts.length,
    artifacts,
  };
}

export async function verifyLocalArtifacts({ dir, includeHashes = true, includeInternals = false } = {}) {
  const manifest = await buildLocalArtifactManifest({ dir, includeHashes });
  const checks = [];
  const issues = [];

  for (const spec of LOCAL_ARTIFACTS) {
    const path = join(manifest.baseDir, spec.filename);
    const manifestArtifact = manifest.artifacts.find((artifact) => artifact.name === spec.name);

    if (!manifestArtifact.exists) {
      checks.push({
        name: spec.name,
        status: 'missing',
        exists: false,
        parseOk: false,
        path,
        details: {},
      });
      if (spec.name === 'graph') {
        issues.push(makeIssue({
          severity: 'warning',
          code: 'GRAPH_MISSING',
          artifact: 'graph',
          message: 'graph.json is missing (fresh state or external deletion).',
        }));
      }
      if (spec.name === 'wal') {
        issues.push(makeIssue({
          severity: 'warning',
          code: 'WAL_MISSING',
          artifact: 'wal',
          message: 'mutations.wal is missing (no WAL trail available yet).',
        }));
      }
      continue;
    }

    try {
      const inspected = await inspectArtifact(spec, path);
      checks.push(inspected);
      if (inspected.status === 'error') {
        issues.push(makeIssue({
          severity: 'error',
          code: 'WAL_MALFORMED',
          artifact: spec.name,
          message: `mutations.wal contains ${inspected.details.malformedCount} malformed line(s).`,
        }));
      }
    } catch (error) {
      checks.push({
        name: spec.name,
        status: 'error',
        exists: true,
        parseOk: false,
        path,
        details: {},
      });
      issues.push(makeIssue({
        severity: 'error',
        code: `${spec.name.toUpperCase()}_MALFORMED`,
        artifact: spec.name,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const status = summarizeStatus(issues);
  const artifacts = includeInternals ? checks : checks.map((artifact) => sanitizeArtifactCheck(artifact));
  return {
    status,
    healthy: status === 'ok',
    manifest,
    artifacts,
    issues,
  };
}

function sanitizeArtifactCheck(artifact) {
  const details = artifact?.details && typeof artifact.details === 'object'
    ? { ...artifact.details }
    : {};
  if (Array.isArray(details.malformed)) {
    details.malformed = details.malformed.slice(0, 5);
  }

  return {
    name: artifact.name,
    path: artifact.path,
    kind: artifact.kind,
    role: artifact.role,
    exists: artifact.exists,
    status: artifact.status,
    parseOk: artifact.parseOk,
    details,
  };
}

function findArtifact(result, name) {
  return result.artifacts.find((artifact) => artifact.name === name) || null;
}

export async function validateRecoveryDryRun({ dir, includeTemporal = false } = {}) {
  const integrity = await verifyLocalArtifacts({ dir, includeHashes: false, includeInternals: true });
  const issues = [...integrity.issues];

  const graphArtifact = findArtifact(integrity, 'graph');
  const walArtifact = findArtifact(integrity, 'wal');
  const snapshotArtifact = findArtifact(integrity, 'snapshot');

  const graphReadable = Boolean(graphArtifact?.exists && graphArtifact.parseOk);
  const walReadable = Boolean(walArtifact?.exists && walArtifact.parseOk);
  const snapshotReadable = Boolean(snapshotArtifact?.exists && snapshotArtifact.parseOk);

  const liveMemories = graphReadable ? (graphArtifact.parsed || []) : [];
  const liveSubset = projectLiveMutationSubsetState(liveMemories);

  let mode = 'none';
  if (snapshotReadable && walReadable) mode = 'snapshot_plus_wal';
  else if (snapshotReadable && !walArtifact?.exists) mode = 'snapshot_only';
  else if (walReadable) mode = 'wal_only';
  else if (graphReadable) mode = 'graph_only';

  let replay = null;
  let comparison = null;
  let mutationSubsetReplayable = false;
  let reconstructable = false;

  if (mode === 'graph_only') {
    reconstructable = true;
  } else if (mode === 'snapshot_plus_wal' || mode === 'snapshot_only' || mode === 'wal_only') {
    const events = walReadable ? (walArtifact.events || []) : [];
    const malformed = walReadable ? (walArtifact.malformed || []) : [];
    replay = mode === 'wal_only'
      ? replayMutationSubset(events, { malformed })
      : replaySnapshotAndWal(snapshotArtifact.snapshot, events, { malformed });
    mutationSubsetReplayable = malformed.length === 0;

    if (graphReadable) {
      comparison = compareMutationSubsetStates(liveSubset, replay, { includeTemporal });
      reconstructable = mutationSubsetReplayable && comparison.equivalent;
      if (!comparison.equivalent) {
        issues.push(makeIssue({
          severity: 'error',
          code: 'RECOVERY_DRY_RUN_MISMATCH',
          artifact: 'graph',
          message: `Replay diverges from live graph for ${comparison.differences.length} field(s).`,
        }));
      }
    } else {
      reconstructable = false;
      issues.push(makeIssue({
        severity: 'warning',
        code: 'GRAPH_UNAVAILABLE_FOR_COMPARISON',
        artifact: 'graph',
        message: 'graph.json is unavailable; mutation replay cannot be compared to live local state.',
      }));
    }
  } else {
    reconstructable = false;
    issues.push(makeIssue({
      severity: 'warning',
      code: 'NO_RECOVERY_ARTIFACTS',
      artifact: 'graph',
      message: 'No graph, WAL, or snapshot artifacts were found for dry-run recovery validation.',
    }));
  }

  const status = summarizeStatus(issues);
  return {
    status,
    reconstructable,
    mode,
    graphReadable,
    mutationSubsetReplayable,
    live: {
      memoryCount: liveMemories.length,
      projectedCount: Object.keys(liveSubset.byMemoryId || {}).length,
    },
    replay: replay
      ? {
        applied: replay.applied,
        timelineCount: Array.isArray(replay.timeline) ? replay.timeline.length : 0,
        malformedCount: Array.isArray(replay.malformed) ? replay.malformed.length : 0,
      }
      : null,
    comparison: comparison
      ? {
        equivalent: comparison.equivalent,
        compared: comparison.compared,
        differenceCount: comparison.differences.length,
        differences: comparison.differences,
      }
      : null,
    issues,
    integrity: {
      status: integrity.status,
      healthy: integrity.healthy,
      manifest: integrity.manifest,
      artifacts: integrity.artifacts.map((artifact) => sanitizeArtifactCheck(artifact)),
      issues: integrity.issues,
    },
  };
}

export function formatRecoveryCheckReport({
  manifest,
  integrity,
  recovery,
  pendingSync = null,
} = {}) {
  const lines = [];
  lines.push(`Manifest v${manifest?.v ?? WAL_RECOVERY_MANIFEST_VERSION} @ ${manifest?.generatedAt || 'unknown'}`);
  lines.push(`Base dir: ${manifest?.baseDir || 'unknown'}`);
  lines.push(`Artifacts: ${manifest?.existingCount ?? 0}/${manifest?.artifactCount ?? 0} present`);
  lines.push(`Integrity: ${integrity?.status || 'unknown'} (${integrity?.issues?.length ?? 0} issue(s))`);
  lines.push(`Recovery dry-run: ${recovery?.status || 'unknown'} | mode=${recovery?.mode || 'none'} | reconstructable=${Boolean(recovery?.reconstructable)}`);
  if (recovery?.comparison) {
    lines.push(`Recovery compare: equivalent=${recovery.comparison.equivalent} differences=${recovery.comparison.differenceCount}`);
  }
  if (pendingSync) {
    lines.push(`Pending sync: queue=${pendingSync.queueCount} dlq=${pendingSync.deadLetterCount} ready=${pendingSync.readyCount}`);
  }

  const issueList = [
    ...(integrity?.issues || []),
    ...(recovery?.issues || []),
  ];
  const dedupedIssues = [];
  const seenIssues = new Set();
  for (const issue of issueList) {
    const key = `${issue.severity}|${issue.code}|${issue.message}`;
    if (seenIssues.has(key)) continue;
    seenIssues.add(key);
    dedupedIssues.push(issue);
  }

  if (dedupedIssues.length > 0) {
    lines.push('Issues:');
    for (const issue of dedupedIssues) {
      lines.push(`- [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  return lines.join('\n');
}






