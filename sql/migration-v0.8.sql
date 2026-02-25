-- =============================================================================
-- neolata-mem v0.8 Migration: Trustworthy Memory
-- =============================================================================
-- Run against your Supabase project to upgrade from v0.7 → v0.8.
-- Safe to re-run (all statements use IF NOT EXISTS / IF EXISTS).
--
-- Prerequisites:
--   - pgvector extension enabled (CREATE EXTENSION IF NOT EXISTS vector)
--   - Existing 'memories' table from v0.7
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. NEW COLUMNS ON MEMORIES TABLE
-- ─────────────────────────────────────────────────────────────────────────────

-- Trust & provenance
ALTER TABLE memories ADD COLUMN IF NOT EXISTS claim jsonb;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS provenance jsonb
  DEFAULT '{"source":"inference","corroboration":1,"trust":0.5}';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence float DEFAULT 0.5;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcements integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS disputes integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS supersedes text[];

-- Quarantine
ALTER TABLE memories ADD COLUMN IF NOT EXISTS quarantine jsonb;

-- Compression
ALTER TABLE memories ADD COLUMN IF NOT EXISTS compressed jsonb;

-- Spaced repetition / decay
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count integer DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS stability float;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_review_interval float;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

-- Claim-based lookups (subject + predicate)
CREATE INDEX IF NOT EXISTS idx_memories_claim_sp
  ON memories ((claim->>'subject'), (claim->>'predicate'))
  WHERE claim IS NOT NULL;

-- Status filtering
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories (status);

-- Confidence-based queries
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories (confidence);

-- Agent filtering
CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories (agent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PENDING CONFLICTS TABLE
-- ─────────────────────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_pending_conflicts_unresolved
  ON pending_conflicts (created_at)
  WHERE resolved_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. EPISODES TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- Table name derived from memories table: if memories='memories' → 'episodes'
-- (supabase-storage.mjs uses table.replace('memories', 'episodes'))

CREATE TABLE IF NOT EXISTS episodes (
  id text PRIMARY KEY,
  name text NOT NULL,
  summary text,
  agents text[] DEFAULT '{}',
  memory_ids text[] DEFAULT '{}',
  tags text[] DEFAULT '{}',
  metadata jsonb,
  time_range_start timestamptz,
  time_range_end timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_agents ON episodes USING GIN (agents);
CREATE INDEX IF NOT EXISTS idx_episodes_tags ON episodes USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes (time_range_start, time_range_end);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. LABELED CLUSTERS TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- Table name: 'memory_clusters'

CREATE TABLE IF NOT EXISTS memory_clusters (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text,
  memory_ids text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_clusters_label ON memory_clusters (label);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ARCHIVE TABLE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memories_archive (
  id text PRIMARY KEY,
  agent_id text,
  content text,
  category text,
  importance float,
  tags text[] DEFAULT '{}',
  created_at timestamptz,
  event_at timestamptz,
  archived_at timestamptz DEFAULT now(),
  archived_reason text
);

CREATE INDEX IF NOT EXISTS idx_memories_archive_agent ON memories_archive (agent_id);
CREATE INDEX IF NOT EXISTS idx_memories_archive_archived_at ON memories_archive (archived_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. SEMANTIC SEARCH RPC (updated for v0.8 columns)
-- ─────────────────────────────────────────────────────────────────────────────

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
    m.id, m.agent_id AS agent, m.content AS memory, m.category,
    m.importance, m.tags, m.created_at,
    m.updated_at, m.event_at,
    m.claim, m.provenance, m.confidence,
    m.status, m.reinforcements, m.disputes,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE 1 - (m.embedding <=> query_embedding) > match_threshold
    AND (filter_agent IS NULL OR m.agent_id = filter_agent)
    AND (filter_status IS NULL OR m.status = filter_status)
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ROW-LEVEL SECURITY (recommended)
-- ─────────────────────────────────────────────────────────────────────────────
-- Enable RLS on all tables. Adjust policies to your auth setup.
-- These permissive policies allow all operations via anon key — tighten as needed.

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_clusters ENABLE ROW LEVEL SECURITY;

-- Permissive policies (replace with your auth logic)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'memories_all' AND tablename = 'memories') THEN
    CREATE POLICY memories_all ON memories FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'archive_all' AND tablename = 'memories_archive') THEN
    CREATE POLICY archive_all ON memories_archive FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'conflicts_all' AND tablename = 'pending_conflicts') THEN
    CREATE POLICY conflicts_all ON pending_conflicts FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'episodes_all' AND tablename = 'episodes') THEN
    CREATE POLICY episodes_all ON episodes FOR ALL USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'clusters_all' AND tablename = 'memory_clusters') THEN
    CREATE POLICY clusters_all ON memory_clusters FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Done. Verify with:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'memories' ORDER BY ordinal_position;
-- ─────────────────────────────────────────────────────────────────────────────
