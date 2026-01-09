-- Migration: 004_add_sequence.sql
-- Description: Add sequence column to pages table to preserve HTML discovery order
-- Created: Fix for maintaining correct URL order in Excel and tree view

-- Add sequence column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pages' AND column_name = 'sequence'
  ) THEN
    ALTER TABLE pages ADD COLUMN sequence INTEGER;
    COMMENT ON COLUMN pages.sequence IS 'Sequence number preserving HTML discovery order within same depth';
    
    -- For existing rows, set sequence based on crawled_at to maintain backward compatibility
    -- This ensures existing data still has an order
    UPDATE pages SET sequence = sub.row_num
    FROM (
      SELECT id, row_number() OVER (PARTITION BY job_id, depth ORDER BY crawled_at) as row_num
      FROM pages
    ) sub
    WHERE pages.id = sub.id;
  END IF;
END $$;

-- Add index for better query performance when ordering by sequence
CREATE INDEX IF NOT EXISTS idx_pages_job_depth_sequence 
ON pages(job_id, depth, sequence);
