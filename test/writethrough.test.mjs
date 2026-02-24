import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryGraph } from '../src/graph.mjs';
import { memoryStorage } from '../src/storage.mjs';
import { noopEmbeddings } from '../src/embeddings.mjs';
import { markdownWritethrough, webhookWritethrough } from '../src/writethrough.mjs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

function makeGraph() {
  return new MemoryGraph({
    storage: memoryStorage(),
    embeddings: noopEmbeddings(),
  });
}

describe('markdownWritethrough', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-test-'));
  });

  it('creates a daily markdown file on store', async () => {
    const graph = makeGraph();
    const detach = markdownWritethrough(graph, { dir });

    await graph.store('agent-1', 'User likes dark mode');
    // Small delay for async handler
    await new Promise(r => setTimeout(r, 50));

    const date = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(dir, `memories-${date}.md`), 'utf8');
    expect(content).toContain('User likes dark mode');
    expect(content).toContain('agent-1');

    detach();
    await rm(dir, { recursive: true, force: true });
  });

  it('appends to existing file', async () => {
    const graph = makeGraph();
    markdownWritethrough(graph, { dir });

    await graph.store('a1', 'Fact one');
    await new Promise(r => setTimeout(r, 50));
    await graph.store('a1', 'Fact two');
    await new Promise(r => setTimeout(r, 50));

    const date = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(dir, `memories-${date}.md`), 'utf8');
    expect(content).toContain('Fact one');
    expect(content).toContain('Fact two');

    await rm(dir, { recursive: true, force: true });
  });

  it('custom format function', async () => {
    const graph = makeGraph();
    markdownWritethrough(graph, {
      dir,
      format: (ev) => `CUSTOM: ${ev.content}\n`,
    });

    await graph.store('a1', 'Custom fact');
    await new Promise(r => setTimeout(r, 50));

    const date = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(dir, `memories-${date}.md`), 'utf8');
    expect(content).toContain('CUSTOM: Custom fact');

    await rm(dir, { recursive: true, force: true });
  });

  it('detach stops writing', async () => {
    const graph = makeGraph();
    const detach = markdownWritethrough(graph, { dir });

    await graph.store('a1', 'Before detach');
    await new Promise(r => setTimeout(r, 50));
    detach();

    await graph.store('a1', 'After detach');
    await new Promise(r => setTimeout(r, 50));

    const date = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(dir, `memories-${date}.md`), 'utf8');
    expect(content).toContain('Before detach');
    expect(content).not.toContain('After detach');

    await rm(dir, { recursive: true, force: true });
  });

  it('throws if dir is missing', () => {
    const graph = makeGraph();
    expect(() => markdownWritethrough(graph, {})).toThrow('dir is required');
  });
});

describe('webhookWritethrough', () => {
  it('POSTs to webhook on store', async () => {
    const posted = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      posted.push({ url, body: JSON.parse(opts.body) });
      return { ok: true };
    });

    const graph = makeGraph();
    webhookWritethrough(graph, { url: 'https://hooks.test/mem' });

    await graph.store('a1', 'Webhook fact');
    await new Promise(r => setTimeout(r, 50));

    expect(posted.length).toBe(1);
    expect(posted[0].url).toBe('https://hooks.test/mem');
    expect(posted[0].body.event).toBe('store');
    expect(posted[0].body.content).toBe('Webhook fact');
  });

  it('forwards multiple event types', async () => {
    const posted = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      posted.push(JSON.parse(opts.body));
      return { ok: true };
    });

    const graph = makeGraph();
    webhookWritethrough(graph, {
      url: 'https://hooks.test/mem',
      events: ['store', 'search'],
    });

    await graph.store('a1', 'Multi-event fact');
    await graph.search('a1', 'test');
    await new Promise(r => setTimeout(r, 50));

    const events = posted.map(p => p.event);
    expect(events).toContain('store');
    expect(events).toContain('search');
  });

  it('throws if url is missing', () => {
    const graph = makeGraph();
    expect(() => webhookWritethrough(graph, {})).toThrow('url is required');
  });
});
