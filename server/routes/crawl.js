const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/init');
const { crawlQueue } = require('../queue/queue');
const { getSitemap } = require('../utils/sitemapGenerator');

const router = express.Router();

/**
 * POST /api/crawl
 * Start crawling one or more websites
 */
router.post('/', async (req, res) => {
  try {
    const { websites, maxDepth = 3, maxPages = 500 } = req.body;
    
    if (!websites || !Array.isArray(websites) || websites.length === 0) {
      return res.status(400).json({ error: 'websites array is required' });
    }
    
    const jobIds = [];
    
    // Create jobs for each website
    for (const website of websites) {
      const jobId = uuidv4();
      
      // Insert job into database
      await pool.query(
        'INSERT INTO crawl_jobs (id, domain, max_depth, max_pages) VALUES ($1, $2, $3, $4)',
        [jobId, website, maxDepth, maxPages]
      );
      
      // Add to queue
      await crawlQueue.add('crawl', {
        jobId,
        domain: website,
        maxDepth,
        maxPages,
      }, {
        jobId,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      });
      
      jobIds.push(jobId);
    }
    
    res.json({
      success: true,
      jobs: jobIds.map(id => ({ id, status: 'PENDING' })),
    });
  } catch (error) {
    console.error('Error starting crawl:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/crawl/:jobId
 * Get crawl job details
 */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    const jobResult = await pool.query(
      'SELECT * FROM crawl_jobs WHERE id = $1',
      [jobId]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const job = jobResult.rows[0];
    
    // Get pages count
    const pagesResult = await pool.query(
      'SELECT COUNT(*) as count FROM pages WHERE job_id = $1',
      [jobId]
    );
    
    // Get sitemap
    const sitemapResult = await pool.query(
      'SELECT * FROM sitemaps WHERE job_id = $1',
      [jobId]
    );
    
    // Get recommendations
    const recsResult = await pool.query(
      'SELECT * FROM ai_recommendations WHERE job_id = $1 ORDER BY created_at',
      [jobId]
    );
    
    res.json({
      ...job,
      pagesCount: parseInt(pagesResult.rows[0].count),
      sitemap: sitemapResult.rows[0] || null,
      recommendations: recsResult.rows,
    });
  } catch (error) {
    console.error('Error fetching crawl:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/crawl
 * List all crawl jobs
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        cj.*,
        COUNT(p.id) as pages_count
      FROM crawl_jobs cj
      LEFT JOIN pages p ON p.job_id = cj.id
      GROUP BY cj.id
      ORDER BY cj.created_at DESC
      LIMIT 100`
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error listing crawls:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/crawl/:jobId
 * Cancel/delete a crawl job
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Remove from queue if pending
    const job = await crawlQueue.getJob(jobId);
    if (job) {
      await job.remove();
    }
    
    // Delete from database (cascade will handle related records)
    await pool.query('DELETE FROM crawl_jobs WHERE id = $1', [jobId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting crawl:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/crawl/:jobId/download/:format
 * Download sitemap in specified format (json, xml, tree)
 */
router.get('/:jobId/download/:format', async (req, res) => {
  try {
    const { jobId, format } = req.params;
    
    if (!['json', 'xml', 'tree'].includes(format.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid format. Use json, xml, or tree' });
    }
    
    const sitemap = await getSitemap(jobId, format);
    
    res.setHeader('Content-Type', sitemap.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${sitemap.filename}"`);
    res.send(sitemap.content);
  } catch (error) {
    console.error('Error generating sitemap:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

