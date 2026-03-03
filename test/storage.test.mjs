import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonStorage } from '../src/storage.mjs';

function mockMemory(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'mem_1234567890_abc123',
    agent: 'agent-1',
    memory: 'Redis runs on port 6379',
    category: 'fact',
    importance: 0.7,
    tags: ['infra', 'redis'],
    embedding: null,
    links: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('jsonStorage', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'neolata-mem-storage-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('save() persists valid memory data to graph.json', async () => {
    const storage = jsonStorage({ dir: tempRoot });
    const memories = [mockMemory()];

    await storage.save(memories);

    const graphPath = join(tempRoot, 'graph.json');
    assert.equal(existsSync(graphPath), true);
    const raw = await readFile(graphPath, 'utf8');
    assert.deepEqual(JSON.parse(raw), memories);
  });

  it('save() creates nested storage directories when missing', async () => {
    const nestedDir = join(tempRoot, 'a', 'b', 'c');
    const storage = jsonStorage({ dir: nestedDir });

    await storage.save([mockMemory()]);

    assert.equal(existsSync(join(nestedDir, 'graph.json')), true);
  });

  it('load() returns previously saved data with full integrity', async () => {
    const storage = jsonStorage({ dir: tempRoot });
    const memories = [
      mockMemory(),
      mockMemory({
        id: 'mem_1234567891_def456',
        memory: 'PostgreSQL default port is 5432',
        tags: ['infra', 'postgres'],
      }),
    ];

    await storage.save(memories);
    const loaded = await storage.load();

    assert.deepEqual(loaded, memories);
  });

  it('load() supports files with UTF-8 BOM', async () => {
    const storage = jsonStorage({ dir: tempRoot });
    const memories = [mockMemory()];
    const graphPath = join(tempRoot, 'graph.json');

    await writeFile(graphPath, `\uFEFF${JSON.stringify(memories)}`, 'utf8');
    const loaded = await storage.load();

    assert.deepEqual(loaded, memories);
  });

  it('saveArchive() and loadArchive() round-trip archived memories', async () => {
    const storage = jsonStorage({ dir: tempRoot });
    const archived = [mockMemory({ id: 'mem_9_archiv', memory: 'Old archived memory' })];

    await storage.saveArchive(archived);
    const loaded = await storage.loadArchive();

    assert.deepEqual(loaded, archived);
  });

  it('loadArchive() returns empty array when archive file does not exist', async () => {
    const storage = jsonStorage({ dir: tempRoot });

    const loaded = await storage.loadArchive();

    assert.deepEqual(loaded, []);
  });

  it('genId() returns ids in expected mem_<timestamp>_<suffix> format', () => {
    const storage = jsonStorage({ dir: tempRoot });
    const id = storage.genId();

    assert.match(id, /^mem_/);
  });

  it('genId() generates unique ids across many calls', () => {
    const storage = jsonStorage({ dir: tempRoot });
    const ids = new Set();

    for (let i = 0; i < 500; i += 1) {
      ids.add(storage.genId());
    }

    assert.equal(ids.size, 500);
  });

  it('load() returns empty array for a fresh directory', async () => {
    const storage = jsonStorage({ dir: tempRoot });

    const loaded = await storage.load();

    assert.deepEqual(loaded, []);
  });

  it('supports custom filename option for active graph file', async () => {
    const filename = 'agent-a.json';
    const storage = jsonStorage({ dir: tempRoot, filename });
    const memories = [mockMemory()];

    await storage.save(memories);
    const loaded = await storage.load();

    assert.equal(existsSync(join(tempRoot, filename)), true);
    assert.deepEqual(loaded, memories);
  });
});
