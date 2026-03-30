import { describe, it, expect } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
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

describe('WAL manifest/integrity/recovery', () => {
  it('generates a deterministic local artifact manifest for present files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-manifest-'));
    try {
      await writeFile(join(dir, 'graph.json'), JSON.stringify([], null, 2), 'utf8');
      const wal = jsonlWal({ dir });
      await wal.append({
        v: 1,
        type: 'mutation',
        id: 'wal_a',
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
      expect(manifest.v).toBe(1);
      expect(manifest.baseDir).toBe(dir);

      const graph = manifest.artifacts.find((artifact) => artifact.name === 'graph');
      const walArtifact = manifest.artifacts.find((artifact) => artifact.name === 'wal');
      const snapshotArtifact = manifest.artifacts.find((artifact) => artifact.name === 'snapshot');

      expect(graph?.exists).toBe(true);
      expect(walArtifact?.exists).toBe(true);
      expect(snapshotArtifact?.exists).toBe(true);
      expect(graph?.sha256?.length).toBe(64);
      expect(walArtifact?.sha256?.length).toBe(64);
      expect(snapshotArtifact?.sha256?.length).toBe(64);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flags missing and malformed artifacts during integrity verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-integrity-'));
    try {
      const missing = await verifyLocalArtifacts({ dir });
      expect(missing.status).toBe('degraded');
      expect(missing.issues.some((issue) => issue.code === 'GRAPH_MISSING')).toBe(true);
      expect(missing.issues.some((issue) => issue.code === 'WAL_MISSING')).toBe(true);

      await appendFile(join(dir, 'mutations.wal'), 'not-json\n', 'utf8');
      const malformed = await verifyLocalArtifacts({ dir });
      expect(malformed.status).toBe('error');
      expect(malformed.issues.some((issue) => issue.code === 'WAL_MALFORMED')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs recovery dry-run without mutating state and detects divergence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neolata-recovery-dry-'));
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

      const valid = await validateRecoveryDryRun({ dir });
      expect(valid.mode).toBe('snapshot_plus_wal');
      expect(valid.reconstructable).toBe(true);
      expect(valid.comparison?.equivalent).toBe(true);

      const graphPath = join(dir, 'graph.json');
      const graphRaw = await readFile(graphPath, 'utf8');
      const parsed = JSON.parse(graphRaw);
      parsed[0].reinforcements = (parsed[0].reinforcements || 0) + 1;
      await writeFile(graphPath, JSON.stringify(parsed, null, 2), 'utf8');

      const divergent = await validateRecoveryDryRun({ dir });
      expect(divergent.reconstructable).toBe(false);
      expect(divergent.comparison?.equivalent).toBe(false);
      expect(divergent.issues.some((issue) => issue.code === 'RECOVERY_DRY_RUN_MISMATCH')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
