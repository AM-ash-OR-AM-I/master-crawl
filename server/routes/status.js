const express = require('express');
const { pool } = require('../db/init');

const router = express.Router();

/**
 * GET /api/status
 * Get status of all active crawl jobs (for dashboard table)
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        cj.id,
        cj.domain,
        cj.status,
        cj.max_depth,
        cj.max_pages,
        cj.pages_crawled,
        cj.started_at,
        cj.completed_at,
        cj.error_message,
        COUNT(p.id) as actual_pages_count
      FROM crawl_jobs cj
      LEFT JOIN pages p ON p.job_id = cj.id
      GROUP BY cj.id
      ORDER BY cj.created_at DESC`
    );
    
    const jobs = result.rows.map(row => ({
      id: row.id,
      website: row.domain,
      status: row.status,
      depth: row.max_depth,
      maxPages: row.max_pages,
      pagesCrawled: row.pages_crawled || 0,
      actualPagesCount: parseInt(row.actual_pages_count) || 0,
      progress: row.max_pages > 0 
        ? Math.min(100, Math.round((row.pages_crawled / row.max_pages) * 100))
        : 0,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error_message,
    }));
    
    res.json(jobs);
  } catch (error) {
    console.error('Error fetching status:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

