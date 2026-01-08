-- Migration: 002_add_original_href.sql
-- Description: Add original_href column to pages table
-- Created: Migration for tracking original href attributes

-- Add original_href column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pages' AND column_name = 'original_href'
  ) THEN
    ALTER TABLE pages ADD COLUMN original_href TEXT;
    COMMENT ON COLUMN pages.original_href IS 'Original href attribute from the link that discovered this page';
  END IF;
END $$;
