-- Archive table for neolata-mem decay
CREATE TABLE IF NOT EXISTS memories_archive (
  id UUID PRIMARY KEY,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact',
  importance FLOAT NOT NULL DEFAULT 0.5,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_archive_agent ON memories_archive(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_archive_archived ON memories_archive(archived_at);

-- Vector search RPCs
CREATE OR REPLACE FUNCTION search_memories_semantic(
  agent TEXT,
  query_embedding VECTOR(1024),
  match_count INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID, agent_id TEXT, content TEXT, category TEXT,
  importance FLOAT, tags TEXT[],
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT m.id, m.agent_id, m.content, m.category, m.importance, m.tags,
    m.created_at, m.updated_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.embedding IS NOT NULL
    AND m.agent_id = agent
    AND 1 - (m.embedding <=> query_embedding) >= min_similarity
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION search_memories_global(
  query_embedding VECTOR(1024),
  match_count INT DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID, agent_id TEXT, content TEXT, category TEXT,
  importance FLOAT, tags TEXT[],
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT m.id, m.agent_id, m.content, m.category, m.importance, m.tags,
    m.created_at, m.updated_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) >= min_similarity
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;
