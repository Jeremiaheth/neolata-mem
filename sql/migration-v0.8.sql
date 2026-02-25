-- neolata-mem v0.8.0 migration: Trustworthy Memory
-- Run this against your Supabase project to add v0.8 fields.

-- New columns on memories table
ALTER TABLE memories ADD COLUMN IF NOT EXISTS claim jsonb;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS provenance jsonb DEFAULT '{"source":"inference","corroboration":1,"trust":0.5}';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence float DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcements integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS disputes integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes text[];

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memories_claim_sp
  ON memories ((claim->>'subject'), (claim->>'predicate'))
  WHERE claim IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories (confidence);

-- Pending conflicts table
CREATE TABLE IF NOT EXISTS pending_conflicts (
  id text PRIMARY KEY,
  new_id text NOT NULL,
  existing_id text NOT NULL,
  new_trust float NOT NULL,
  existing_trust float NOT NULL,
  new_claim jsonb,
  existing_claim jsonb,
  created_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  resolution text
);

-- Update search RPCs to filter by status
CREATE OR REPLACE FUNCTION search_memories_semantic(
  query_embedding vector(1024),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 10,
  filter_agent text DEFAULT NULL,
  filter_status text DEFAULT 'active'
)
RETURNS TABLE (
  id text, agent text, memory text, category text,
  importance float, tags text[], created_at timestamptz,
  updated_at timestamptz, event_at timestamptz,
  claim jsonb, provenance jsonb, confidence float,
  status text, reinforcements int, disputes int,
  similarity float
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.agent, m.memory, m.category,
    m.importance, m.tags, m.created_at,
    m.updated_at, m.event_at,
    m.claim, m.provenance, m.confidence,
    m.status, m.reinforcements, m.disputes,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_agent IS NULL OR m.agent = filter_agent)
    AND (filter_status IS NULL OR m.status = filter_status)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
