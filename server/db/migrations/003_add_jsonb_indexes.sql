-- Migration: 003_add_jsonb_indexes.sql
-- Description: Add GIN indexes on JSONB columns for faster queries
-- Created: Performance optimization for JSONB operations

-- GIN index on sitemaps.original_sitemap for faster JSONB path queries
-- This significantly speeds up queries like original_sitemap->'_crawlMeta'
CREATE INDEX IF NOT EXISTS idx_sitemaps_original_sitemap_gin 
ON sitemaps USING GIN (original_sitemap);

-- GIN index on ai_recommendations.before and after JSONB columns
-- Speeds up JSONB operations on recommendation data
CREATE INDEX IF NOT EXISTS idx_ai_recommendations_before_gin 
ON ai_recommendations USING GIN (before);

CREATE INDEX IF NOT EXISTS idx_ai_recommendations_after_gin 
ON ai_recommendations USING GIN (after);

-- Composite index for common query pattern: job_id + created_at
-- This helps with ORDER BY created_at queries
CREATE INDEX IF NOT EXISTS idx_ai_recommendations_job_created 
ON ai_recommendations(job_id, created_at);

-- Index on pages for common filtering patterns
-- Composite index for job_id + depth (common in sitemap generation)
CREATE INDEX IF NOT EXISTS idx_pages_job_depth 
ON pages(job_id, depth);

-- Index on pages for URL lookups (if not already covered by unique constraint)
-- The unique constraint on (job_id, url) already provides an index, but this helps with url-only queries
CREATE INDEX IF NOT EXISTS idx_pages_url_lookup 
ON pages(url) WHERE url IS NOT NULL;
