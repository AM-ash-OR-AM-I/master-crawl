-- Enum for crawl job status (create if not exists)
DO $$ BEGIN
  CREATE TYPE crawl_status AS ENUM (
    'PENDING',
    'CRAWLING',
    'PROCESSING',
    'AI_ANALYSIS',
    'COMPLETED',
    'FAILED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Crawl jobs table
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  status crawl_status NOT NULL DEFAULT 'PENDING',
  max_depth INTEGER NOT NULL DEFAULT 3,
  max_pages INTEGER NOT NULL DEFAULT 500,
  pages_crawled INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pages table
CREATE TABLE IF NOT EXISTS pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  parent_url TEXT,
  title TEXT,
  status_code INTEGER,
  crawled_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, url)
);

-- Add original_href column if it doesn't exist (for existing databases)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pages' AND column_name = 'original_href'
  ) THEN
    ALTER TABLE pages ADD COLUMN original_href TEXT;
  END IF;
END $$;

-- AI recommendations table
CREATE TABLE IF NOT EXISTS ai_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  before JSONB,
  after JSONB,
  explanation TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Sitemap data table (stores final sitemap JSON)
CREATE TABLE IF NOT EXISTS sitemaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  original_sitemap JSONB NOT NULL,
  optimized_sitemap JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(job_id)
);

-- AI prompts table (stores chunk prompts and merge prompt)
CREATE TABLE IF NOT EXISTS ai_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  prompt_type TEXT NOT NULL, -- 'chunk' or 'merge'
  chunk_index INTEGER, -- For chunk prompts, the index of the chunk
  system_prompt TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Unique constraint for chunks (job_id, prompt_type, chunk_index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_chunk ON ai_prompts(job_id, prompt_type, chunk_index) 
  WHERE prompt_type = 'chunk' AND chunk_index IS NOT NULL;

-- Unique constraint for merge (only one merge prompt per job)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_merge ON ai_prompts(job_id, prompt_type) 
  WHERE prompt_type = 'merge';

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status ON crawl_jobs(status);
CREATE INDEX IF NOT EXISTS idx_crawl_jobs_domain ON crawl_jobs(domain);
CREATE INDEX IF NOT EXISTS idx_pages_job_id ON pages(job_id);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
CREATE INDEX IF NOT EXISTS idx_ai_recommendations_job_id ON ai_recommendations(job_id);
CREATE INDEX IF NOT EXISTS idx_sitemaps_job_id ON sitemaps(job_id);
CREATE INDEX IF NOT EXISTS idx_ai_prompts_job_id ON ai_prompts(job_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for crawl_jobs
CREATE TRIGGER update_crawl_jobs_updated_at 
  BEFORE UPDATE ON crawl_jobs 
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

