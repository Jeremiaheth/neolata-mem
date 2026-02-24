/**
 * Write-through hooks for MemoryGraph.
 *
 * Listens to graph events and syncs changes to external destinations
 * (markdown files, webhooks, logs, etc.)
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { validateBaseUrl } from './validate.mjs';

/**
 * Attach a markdown write-through to a MemoryGraph.
 * On every store/evolve, appends a markdown entry to a daily file.
 *
 * @param {import('./graph.mjs').MemoryGraph} graph
 * @param {object} opts
 * @param {string} opts.dir - Directory for markdown files
 * @param {string} [opts.filenamePattern='memories-{date}.md'] - Filename pattern ({date} = YYYY-MM-DD)
 * @param {(event: object) => string} [opts.format] - Custom formatter
 * @returns {() => void} Detach function
 */
export function markdownWritethrough(graph, { dir, filenamePattern = 'memories-{date}.md', format } = {}) {
  if (!dir) throw new Error('markdownWritethrough: dir is required');

  const defaultFormat = (ev) => {
    const time = new Date().toISOString().slice(11, 19);
    return `- **${time}** [${ev.agent}/${ev.category}] ${ev.content} _(importance: ${ev.importance}, links: ${ev.links})_\n`;
  };

  const fmt = format || defaultFormat;

  const handler = async (ev) => {
    const date = new Date().toISOString().slice(0, 10);
    const filename = filenamePattern.replace('{date}', date);
    const filepath = resolve(dir, filename);

    // Path traversal guard
    if (!filepath.startsWith(resolve(dir))) {
      console.error(`[writethrough] Path traversal blocked: ${filename}`);
      return;
    }

    try {
      await mkdir(dirname(filepath), { recursive: true });
      let existing = '';
      try { existing = await readFile(filepath, 'utf8'); } catch { /* new file */ }
      if (!existing) {
        existing = `# Memories — ${date}\n\n`;
      }
      await writeFile(filepath, existing + fmt(ev));
    } catch (err) {
      console.error(`[writethrough] Failed to write ${filepath}:`, err.message);
    }
  };

  graph.on('store', handler);

  // Return detach function
  return () => graph.off('store', handler);
}

/**
 * Attach a webhook write-through to a MemoryGraph.
 * POSTs event data to a URL on every store.
 *
 * @param {import('./graph.mjs').MemoryGraph} graph
 * @param {object} opts
 * @param {string} opts.url - Webhook URL
 * @param {object} [opts.headers={}] - Extra headers
 * @param {string[]} [opts.events=['store']] - Which events to forward
 * @returns {() => void} Detach function
 */
export function webhookWritethrough(graph, { url, headers = {}, events = ['store'], allowPrivate = false } = {}) {
  if (!url) throw new Error('webhookWritethrough: url is required');
  validateBaseUrl(url, { label: 'webhook url', allowPrivate });

  const handler = (eventName) => async (ev) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ event: eventName, ...ev, timestamp: new Date().toISOString() }),
      });
    } catch (err) {
      console.error(`[webhook-writethrough] Failed to POST to ${url}:`, err.message);
    }
  };

  const detachers = events.map(eventName => {
    const h = handler(eventName);
    graph.on(eventName, h);
    return () => graph.off(eventName, h);
  });

  return () => detachers.forEach(d => d());
}
