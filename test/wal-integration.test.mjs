import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';
import { WAL_EVENT_VERSION, jsonlWal } from '../src/wal.mjs';

describe('WAL integration', () => {
  it('persists entries for store/reinforce/dispute/quarantine in call order', async () => {
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
      expect(malformed).toEqual([]);
      expect(events).toHaveLength(4);
      expect(events.map(e => e.op)).toEqual(['store', 'reinforce', 'dispute', 'quarantine']);
      expect(new Set(events.map(e => e.memoryId))).toEqual(new Set([stored.id]));

      for (const event of events) {
        expect(event.v).toBe(WAL_EVENT_VERSION);
        expect(event.type).toBe('mutation');
        expect(typeof event.id).toBe('string');
        expect(event.id.length).toBeGreaterThan(4);
        expect(event.actor).toBe('agent-1');
        expect(typeof event.at).toBe('string');
        expect(event.data && typeof event.data === 'object').toBeTruthy();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
