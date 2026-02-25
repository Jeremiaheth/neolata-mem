import { estimateTokens } from './graph.mjs';

const KEY_MOMENT_RULES = [
  {
    type: 'decision',
    importance: 0.9,
    patterns: ['Decision:', 'We decided', 'Going with', "Let's do", 'Ship it'],
  },
  {
    type: 'preference',
    importance: 0.7,
    patterns: ['I prefer', 'I like', 'I want', 'Always use'],
  },
  {
    type: 'commitment',
    importance: 0.8,
    patterns: ['I will', 'We will', 'TODO:', 'Action item:'],
  },
  {
    type: 'blocker',
    importance: 0.85,
    patterns: ['Blocked by', 'Blocker:', "Can't proceed", 'Waiting on'],
  },
];

function splitIntoSentences(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/[^.!?\n]+(?:[.!?]+|$)/g);
  if (!matches) return [];
  return matches.map((part) => part.trim()).filter(Boolean);
}

function normalize(value) {
  return value.toLowerCase();
}

export function detectKeyMoments(text, { role = 'assistant' } = {}) {
  void role;
  const sentences = splitIntoSentences(text);
  const moments = [];

  for (const sentence of sentences) {
    const sentenceLc = normalize(sentence);
    for (const rule of KEY_MOMENT_RULES) {
      const hasMatch = rule.patterns.some((pattern) => sentenceLc.includes(normalize(pattern)));
      if (!hasMatch) continue;
      moments.push({
        type: rule.type,
        text: sentence,
        importance: rule.importance,
      });
    }
  }

  return moments;
}

export async function heartbeatStore(mem, agent, turns, config = {}) {
  const {
    sessionId,
    topicSlug,
    projectSlug,
    minNewTurns = 3,
    lastStoredIndex = -1,
  } = config;

  const allTurns = Array.isArray(turns) ? turns : [];
  const startIndex = lastStoredIndex + 1;
  const newTurns = startIndex < allTurns.length ? allTurns.slice(startIndex) : [];

  if (newTurns.length < minNewTurns) {
    return {
      stored: 0,
      skipped: 'insufficient_turns',
      lastIndex: lastStoredIndex,
    };
  }

  const ids = [];
  const moments = [];

  for (const turn of newTurns) {
    const detected = detectKeyMoments(turn?.content || '', { role: turn?.role });
    moments.push(...detected);

    for (const moment of detected) {
      const result = await mem.store(agent, moment.text, {
        category: moment.type === 'blocker' ? 'open_thread' : moment.type,
        importance: moment.importance,
        tags: [
          sessionId && `session:${sessionId}`,
          topicSlug && `topic:${topicSlug}`,
          projectSlug && `project:${projectSlug}`,
          `source:${turn?.role || 'assistant'}`,
        ].filter(Boolean),
        provenance: { source: turn?.role === 'user' ? 'user_explicit' : 'system' },
      });
      if (result?.id) ids.push(result.id);
    }
  }

  if (moments.length === 0) {
    const summaryText = newTurns
      .map((turn) => `${turn?.role || 'assistant'}: ${turn?.content || ''}`)
      .join(' ')
      .slice(0, 500);

    const result = await mem.store(agent, summaryText, {
      category: 'session_snapshot',
      importance: 0.5,
      tags: [
        sessionId && `session:${sessionId}`,
        topicSlug && `topic:${topicSlug}`,
        projectSlug && `project:${projectSlug}`,
      ].filter(Boolean),
      provenance: { source: 'system' },
    });
    if (result?.id) ids.push(result.id);
  }

  return {
    stored: ids.length,
    ids,
    lastIndex: allTurns.length - 1,
    moments,
  };
}

const TOPIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'for', 'in', 'on', 'of', 'and', 'or', 'but',
  'with', 'this', 'that', 'it', 'we', 'i', 'you', 'my',
]);

function normalizeTopicWords(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function extractTopicSlug(text, { synonyms = {} } = {}) {
  const words = normalizeTopicWords(text).filter((word) => !TOPIC_STOP_WORDS.has(word));
  if (words.length === 0) return null;

  const counts = new Map();
  for (const word of words) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  let topWord = null;
  let topCount = -1;
  for (const [word, count] of counts.entries()) {
    if (count > topCount || (count === topCount && word < topWord)) {
      topWord = word;
      topCount = count;
    }
  }

  for (const [slug, aliases] of Object.entries(synonyms || {})) {
    if (!Array.isArray(aliases)) continue;
    const normalizedAliases = aliases
      .map((alias) => (typeof alias === 'string' ? alias.toLowerCase().trim() : ''))
      .filter(Boolean);
    if (normalizedAliases.includes(topWord)) return slug;
  }

  return topWord;
}

export async function contextualRecall(mem, agent, seedText, config = {}) {
  const {
    maxTokens = 2000,
    recentCount = 5,
    semanticCount = 8,
    importantCount = 10,
    importanceThreshold = 0.8,
    synonyms = {},
  } = config;

  const topicSlug = extractTopicSlug(seedText, { synonyms });

  const [recent, semantic, importantRaw] = await Promise.all([
    mem.search(agent, '', { limit: recentCount, rerank: false }),
    mem.search(agent, seedText, { limit: semanticCount, rerank: true }),
    mem.search(agent, topicSlug || seedText, { limit: importantCount, rerank: true }),
  ]);

  const important = (importantRaw || []).filter((memory) => (memory?.importance || 0) >= importanceThreshold);
  const merged = [];
  const seen = new Set();

  for (const memory of [...(recent || []), ...(semantic || []), ...important]) {
    if (!memory?.id || seen.has(memory.id)) continue;
    seen.add(memory.id);
    merged.push(memory);
  }

  merged.sort((a, b) => (b?.importance || 0) - (a?.importance || 0));

  const selected = [];
  let totalTokens = 0;
  let excluded = 0;

  for (let i = 0; i < merged.length; i++) {
    const memory = merged[i];
    const tokens = estimateTokens(memory?.memory || '');
    if (totalTokens + tokens > maxTokens) {
      excluded = merged.length - i;
      break;
    }
    totalTokens += tokens;
    selected.push(memory);
  }

  return {
    topicSlug,
    memories: selected,
    totalTokens,
    excluded,
  };
}

export async function preCompactionDump(mem, agent, turns, config = {}) {
  const {
    sessionId,
    topicSlug,
    projectSlug,
    maxTakeaways = 10,
  } = config;

  const allTurns = Array.isArray(turns) ? turns : [];
  const rawMoments = [];
  let index = 0;

  for (const turn of allTurns) {
    const detected = detectKeyMoments(turn?.content || '', { role: turn?.role });
    for (const moment of detected) {
      rawMoments.push({ ...moment, _index: index++ });
    }
  }

  const deduped = new Map();
  for (const moment of rawMoments) {
    const key = (moment?.text || '').toLowerCase().trim();
    if (!key) continue;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, moment);
      continue;
    }
    if (moment.importance > existing.importance) {
      deduped.set(key, moment);
    }
  }

  const selected = [...deduped.values()]
    .sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return a._index - b._index;
    })
    .slice(0, Math.max(0, maxTakeaways));

  const tags = [
    sessionId && `session:${sessionId}`,
    topicSlug && `topic:${topicSlug}`,
    projectSlug && `project:${projectSlug}`,
    'trigger:pre-compaction',
  ].filter(Boolean);

  const ids = [];
  for (const moment of selected) {
    const result = await mem.store(agent, moment.text, {
      category: moment.type === 'blocker' ? 'open_thread' : moment.type,
      tags,
      provenance: { source: 'system' },
    });
    if (result?.id) ids.push(result.id);
  }

  const byType = {
    decision: selected.filter((moment) => moment.type === 'decision').map((moment) => moment.text),
    blocker: selected.filter((moment) => moment.type === 'blocker').map((moment) => moment.text),
    commitment: selected.filter((moment) => moment.type === 'commitment').map((moment) => moment.text),
    preference: selected.filter((moment) => moment.type === 'preference').map((moment) => moment.text),
  };

  const snapshot =
    '## Session Snapshot\n' +
    `**Decisions:** ${byType.decision.length ? byType.decision.join('; ') : 'none'}\n` +
    `**Open threads:** ${byType.blocker.length ? byType.blocker.join('; ') : 'none'}\n` +
    `**Commitments:** ${byType.commitment.length ? byType.commitment.join('; ') : 'none'}\n` +
    `**Preferences:** ${byType.preference.length ? byType.preference.join('; ') : 'none'}`;

  const snapshotResult = await mem.store(agent, snapshot, {
    category: 'session_snapshot',
    importance: 0.7,
    tags,
    provenance: { source: 'system' },
  });

  return {
    takeaways: ids.length,
    snapshotId: snapshotResult?.id || '',
    ids,
  };
}
