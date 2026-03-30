import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryGraph } from '../src/graph.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';
import { jsonStorage } from '../src/storage.mjs';
import { createWalSnapshot } from '../src/wal-snapshot.mjs';
import { buildWalReplayTimeline, replayMutationSubset } from '../src/wal-replay.mjs';
import { jsonlWal } from '../src/wal.mjs';
import {
  buildLocalArtifactManifest,
  validateRecoveryDryRun,
  verifyLocalArtifacts,
} from '../src/wal-recovery.mjs';

async function testManifestGeneration() {
  const dir = await mkdtemp(join(tmpdir(), 'neolata-recovery-manifest-'));
  try {
    await writeFile(join(dir, 'graph.json'), JSON.stringify([], null, 2), 'utf8');
    const wal = jsonlWal({ dir });
    await wal.append({
      v: 1,
      type: 'mutation',
      id: 'wal_1',
      op: 'store',
      memoryId: 'mem_1',
      actor: 'agent-1',
      at: '2026-01-01T00:00:00.000Z',
      data: { status: 'active', category: 'fact', importance: 0.7, links: 0 },
    });

    const replay = replayMutationSubset((await wal.read()).events);
    const snapshot = createWalSnapshot({
      state: replay,
      events: replay.timeline,
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await writeFile(join(dir, 'wal-snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');

    const manifest = await buildLocalArtifactManifest({ dir, includeHashes: true });
    assert.equal(manifest.v, 1);
    assert.equal(manifest.baseDir, dir);

    const graph = manifest.artifacts.find((artifact) => artifact.name === 'graph');
    const walArtifact = manifest.artifacts.find((artifact) => artifact.name === 'wal');
    const snapshotArtifact = manifest.artifacts.find((artifact) => artifact.name === 'snapshot');

    assert.equal(graph?.exists, true);
    assert.equal(walArtifact?.exists, true);
    assert.equal(snapshotArtifact?.exists, true);
    assert.equal(graph?.sha256?.length, 64);
    assert.equal(walArtifact?.sha256?.length, 64);
    assert.equal(snapshotArtifact?.sha256?.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testMalformedAndMissingDetection() {
  const dir = await mkdtemp(join(tmpdir(), 'neolata-recovery-integrity-'));
  try {
    const missing = await verifyLocalArtifacts({ dir });
    assert.equal(missing.status, 'degraded');
    assert.equal(missing.issues.some((issue) => issue.code === 'GRAPH_MISSING'), true);
    assert.equal(missing.issues.some((issue) => issue.code === 'WAL_MISSING'), true);

    await appendFile(join(dir, 'mutations.wal'), 'not-json\n', 'utf8');
    const malformed = await verifyLocalArtifacts({ dir });
    assert.equal(malformed.status, 'error');
    assert.equal(malformed.issues.some((issue) => issue.code === 'WAL_MALFORMED'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testRecoveryDryRun() {
  const dir = await mkdtemp(join(tmpdir(), 'neolata-recovery-dryrun-'));
  try {
    const wal = jsonlWal({ dir });
    const graph = new MemoryGraph({
      storage: jsonStorage({ dir }),
      embeddings: noopEmbeddings(),
      wal,
    });

    const stored = await graph.store('agent-1', 'User likes tea', { importance: 0.7 });
    await graph.reinforce(stored.id, 0.2);
    await graph.dispute(stored.id, { reason: 'uncertain source' });
    await graph.quarantine(stored.id, { reason: 'manual', details: 'review requested' });

    const { events } = await wal.read({ strict: true });
    const timeline = buildWalReplayTimeline(events);
    const split = Math.max(1, Math.floor(timeline.length / 2));
    const snapshot = createWalSnapshot({
      state: replayMutationSubset(timeline.slice(0, split)),
      events: timeline.slice(0, split),
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    await writeFile(join(dir, 'wal-snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');

    const clean = await validateRecoveryDryRun({ dir });
    assert.equal(clean.mode, 'snapshot_plus_wal');
    assert.equal(clean.reconstructable, true);
    assert.equal(clean.comparison?.equivalent, true);

    const graphPath = join(dir, 'graph.json');
    const raw = await readFile(graphPath, 'utf8');
    const parsed = JSON.parse(raw);
    parsed[0].reinforcements = (parsed[0].reinforcements || 0) + 1;
    await writeFile(graphPath, JSON.stringify(parsed, null, 2), 'utf8');

    const divergent = await validateRecoveryDryRun({ dir });
    assert.equal(divergent.reconstructable, false);
    assert.equal(divergent.comparison?.equivalent, false);
    assert.equal(divergent.issues.some((issue) => issue.code === 'RECOVERY_DRY_RUN_MISMATCH'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const checks = [
    { name: 'manifest generation', run: testManifestGeneration },
    { name: 'malformed/missing detection', run: testMalformedAndMissingDetection },
    { name: 'dry-run recovery validation', run: testRecoveryDryRun },
  ];

  for (const check of checks) {
    await check.run();
    console.log(`PASS recovery ${check.name}`);
  }

  console.log('Recovery validation complete.');
}

main().catch((error) => {
  console.error('Recovery validation failed.');
  if (error instanceof Error) console.error(error.stack || error.message);
  else console.error(error);
  process.exit(1);
});
