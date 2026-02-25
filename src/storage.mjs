/**
 * Storage backend interface and implementations.
 * All backends must implement: load() → Memory[], save(memories), genId() → string
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

// ─── JSON File Storage (Zero-Config Default) ────────────────
/**
 * Stores the entire graph as a single JSON file.
 * @param {object} [opts]
 * @param {string} [opts.dir] - Directory for graph files. Defaults to ./neolata-mem-data
 * @param {string} [opts.filename='graph.json']
 */
export function jsonStorage({ dir, filename = 'graph.json' } = {}) {
  const defaultDir = join(process.cwd(), 'neolata-mem-data');
  const storePath = resolve(dir || defaultDir);

  // Path traversal guard: filename must not escape the storage directory
  if (filename !== 'graph.json') {
    const resolvedFile = resolve(storePath, filename);
    if (!resolvedFile.startsWith(storePath)) {
      throw new Error(`filename "${filename}" escapes storage directory`);
    }
  }

  const graphFile = join(storePath, filename);
  const archiveFile = join(storePath, 'archived.json');
  const episodesFile = join(storePath, 'episodes.json');
  const clustersFile = join(storePath, 'clusters.json');
  const pendingConflictsFile = join(storePath, 'pending-conflicts.json');

  return {
    name: 'json',
    async load() {
      await mkdir(storePath, { recursive: true });
      if (!existsSync(graphFile)) return [];
      let raw = await readFile(graphFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // Strip BOM
      return JSON.parse(raw);
    },
    async save(memories) {
      await mkdir(storePath, { recursive: true });
      // Atomic write: write to temp file then rename to prevent corruption on concurrent access
      const tmpFile = graphFile + '.tmp.' + randomUUID().slice(0, 8);
      await writeFile(tmpFile, JSON.stringify(memories, null, 2), 'utf8');
      const { rename } = await import('fs/promises');
      await rename(tmpFile, graphFile);
    },
    async loadArchive() {
      if (!existsSync(archiveFile)) return [];
      let raw = await readFile(archiveFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // Strip BOM (consistency with load)
      return JSON.parse(raw);
    },
    async saveArchive(archived) {
      const tmpFile = archiveFile + '.tmp.' + randomUUID().slice(0, 8);
      await writeFile(tmpFile, JSON.stringify(archived, null, 2), 'utf8');
      const { rename } = await import('fs/promises');
      await rename(tmpFile, archiveFile);
    },
    async loadEpisodes() {
      await mkdir(storePath, { recursive: true });
      if (!existsSync(episodesFile)) return [];
      let raw = await readFile(episodesFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return JSON.parse(raw);
    },
    async saveEpisodes(episodes) {
      await mkdir(storePath, { recursive: true });
      const tmpFile = episodesFile + '.tmp.' + randomUUID().slice(0, 8);
      await writeFile(tmpFile, JSON.stringify(episodes, null, 2), 'utf8');
      const { rename } = await import('fs/promises');
      await rename(tmpFile, episodesFile);
    },
    async loadClusters() {
      await mkdir(storePath, { recursive: true });
      if (!existsSync(clustersFile)) return [];
      let raw = await readFile(clustersFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return JSON.parse(raw);
    },
    async saveClusters(clusters) {
      await mkdir(storePath, { recursive: true });
      const tmpFile = clustersFile + '.tmp.' + randomUUID().slice(0, 8);
      await writeFile(tmpFile, JSON.stringify(clusters, null, 2), 'utf8');
      const { rename } = await import('fs/promises');
      await rename(tmpFile, clustersFile);
    },
    async loadPendingConflicts() {
      await mkdir(storePath, { recursive: true });
      if (!existsSync(pendingConflictsFile)) return [];
      let raw = await readFile(pendingConflictsFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      return JSON.parse(raw);
    },
    async savePendingConflicts(conflicts) {
      await mkdir(storePath, { recursive: true });
      const tmpFile = pendingConflictsFile + '.tmp.' + randomUUID().slice(0, 8);
      await writeFile(tmpFile, JSON.stringify(conflicts, null, 2), 'utf8');
      const { rename } = await import('fs/promises');
      await rename(tmpFile, pendingConflictsFile);
    },
    genId() {
      return `mem_${randomUUID()}`;
    },
    genEpisodeId() {
      return `ep_${randomUUID()}`;
    },
    genClusterId() {
      return `cl_${randomUUID()}`;
    },
  };
}

// ─── In-Memory Storage (Testing / Ephemeral) ────────────────
/**
 * Stores everything in-process. Lost on exit.
 */
export function memoryStorage() {
  let data = [];
  let archive = [];
  let episodes = [];
  let labeledClusters = [];
  let pendingConflicts = [];
  return {
    name: 'memory',
    async load() { return data; },
    async save(memories) { data = memories; },
    async loadArchive() { return archive; },
    async saveArchive(archived) { archive = archived; },
    async loadEpisodes() { return episodes; },
    async saveEpisodes(eps) { episodes = eps; },
    async loadClusters() { return labeledClusters; },
    async saveClusters(cls) { labeledClusters = cls; },
    async loadPendingConflicts() { return pendingConflicts; },
    async savePendingConflicts(conflicts) { pendingConflicts = conflicts; },
    genId() {
      return `mem_${randomUUID()}`;
    },
    genEpisodeId() { return `ep_${randomUUID()}`; },
    genClusterId() { return `cl_${randomUUID()}`; },
  };
}
