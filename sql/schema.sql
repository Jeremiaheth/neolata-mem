-- neolata-mem Supabase Schema
-- Run in Supabase Dashboard SQL Editor
--
-- Prerequisites: pgvector extension enabled
-- CREATE EXTENSION IF NOT EXISTS vector;
--
-- This creates the tables needed for supabaseStorage().
-- If you already have 'memories' and 'memory_links' tables,
-- only run the archive table section.

-- ═══════════════════════════════════════════════════════════
-- 1. MEMORIES TABLE
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'fact',
  importance FLOAT NOT NULL DEFAULT 0.7,
  level TEXT DEFAULT 'long_term',
  tags TEXT[] DEFAULT '{}',
  embedding VECTOR(1024),  -- Adjust dimension to match your model
  access_count INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

-- IVFFlat vector index (tune lists based on row count: sqrt(n))
-- For <1000 rows, lists=10 is fine. Scale up as needed.
CREATE INDEX IF NOT EXISTS idx_memories_embedding_ivfflat
  ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- ═══════════════════════════════════════════════════════════
-- 2. MEMORY LINKS TABLE
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memory_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  strength FLOAT NOT NULL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_source ON memory_links(source_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id);

-- ═══════════════════════════════════════════════════════════
-- 3. MEMORIES ARCHIVE TABLE (new for neolata-mem)
-- ═══════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════
-- 4. VECTOR SEARCH RPCs (optional but recommended)
-- ═══════════════════════════════════════════════════════════

-- Search by agent
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

-- Cross-agent search
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
