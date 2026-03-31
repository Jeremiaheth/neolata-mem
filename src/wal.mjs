import { appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';

export const WAL_EVENT_VERSION = 1;
export const WAL_MUTATION_OPS = new Set(['store', 'reinforce', 'dispute', 'quarantine']);

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function ensureIso(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp string`);
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) throw new Error(`${label} must be an ISO timestamp string`);
}

function isValidSeq(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

export function validateWalMutationEvent(event) {
  ensureObject(event, 'event');
  if (event.v !== WAL_EVENT_VERSION) throw new Error(`event.v must be ${WAL_EVENT_VERSION}`);
  if (event.type !== 'mutation') throw new Error('event.type must be "mutation"');
  if (typeof event.id !== 'string' || !event.id.trim()) throw new Error('event.id must be a non-empty string');
  if (!WAL_MUTATION_OPS.has(event.op)) throw new Error(`event.op must be one of: ${[...WAL_MUTATION_OPS].join(', ')}`);
  if (typeof event.memoryId !== 'string' || !event.memoryId.trim()) throw new Error('event.memoryId must be a non-empty string');
  if (!(event.actor === null || typeof event.actor === 'string')) throw new Error('event.actor must be a string or null');
  ensureIso(event.at, 'event.at');
  if (event.seq !== undefined && !isValidSeq(event.seq)) throw new Error('event.seq must be a positive integer when present');
  ensureObject(event.data, 'event.data');
}

export function createWalMutationEvent({ op, memoryId, actor = null, at, seq, data = {} }) {
  if (!WAL_MUTATION_OPS.has(op)) throw new Error(`Unsupported mutation op: ${op}`);
  if (typeof memoryId !== 'string' || !memoryId.trim()) throw new Error('memoryId must be a non-empty string');
  if (!(actor === null || typeof actor === 'string')) throw new Error('actor must be a string or null');
  if (seq !== undefined && !isValidSeq(seq)) throw new Error('seq must be a positive integer when provided');
  ensureObject(data, 'data');

  const event = {
    v: WAL_EVENT_VERSION,
    type: 'mutation',
    id: `wal_${randomUUID()}`,
    op,
    memoryId,
    actor,
    at: at || new Date().toISOString(),
    ...(seq !== undefined ? { seq } : {}),
    data,
  };

  validateWalMutationEvent(event);
  return event;
}

export function jsonlWal({ dir, filename = 'mutations.wal' } = {}) {
  const defaultDir = join(process.cwd(), 'neolata-mem-data');
  const walDir = resolve(dir || defaultDir);

  if (filename !== 'mutations.wal') {
    const resolvedFile = resolve(walDir, filename);
    if (!resolvedFile.startsWith(walDir)) {
      throw new Error(`filename "${filename}" escapes WAL directory`);
    }
  }

  const path = join(walDir, filename);
  let nextSeq = null;
  let appendChain = Promise.resolve();

  async function readMaxSeq() {
    if (!existsSync(path)) return 0;
    let raw = await readFile(path, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    let maxSeq = 0;
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      if (!line || !line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (isValidSeq(parsed?.seq)) maxSeq = Math.max(maxSeq, parsed.seq);
      } catch {
        // Ignore malformed lines here; read() surfaces these separately.
      }
    }
    return maxSeq;
  }

  async function reserveSeq() {
    if (nextSeq === null) {
      nextSeq = (await readMaxSeq()) + 1;
    }
    const seq = nextSeq;
    nextSeq += 1;
    return seq;
  }

  return {
    name: 'jsonl-wal',
    path,
    async append(event) {
      const op = async () => {
        const hydrated = { ...event };
        if (!isValidSeq(hydrated.seq)) {
          hydrated.seq = await reserveSeq();
        }
        validateWalMutationEvent(hydrated);
        await mkdir(walDir, { recursive: true });
        await appendFile(path, `${JSON.stringify(hydrated)}\n`, 'utf8');
        return hydrated;
      };

      const run = appendChain.then(op, op);
      appendChain = run.then(() => undefined, () => undefined);
      return run;
    },
    async appendMutation(input) {
      const event = createWalMutationEvent(input);
      return this.append(event);
    },
    async read({ strict = false } = {}) {
      if (!existsSync(path)) return { events: [], malformed: [] };
      let raw = await readFile(path, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

      const events = [];
      const malformed = [];
      const lines = raw.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          validateWalMutationEvent(parsed);
          events.push(parsed);
        } catch (error) {
          const issue = {
            line: i + 1,
            raw: line,
            message: error instanceof Error ? error.message : String(error),
          };
          if (strict) {
            throw new Error(`Malformed WAL entry at line ${issue.line}: ${issue.message}`);
          }
          malformed.push(issue);
        }
      }

      return { events, malformed };
    },
  };
}
