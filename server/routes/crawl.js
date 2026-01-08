const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/init');
const { crawlQueue } = require('../queue/queue');
const { getSitemap } = require('../utils/sitemapGenerator');
const { getSystemPrompt, getFullPrompt, generatePromptsWithData } = require('../ai/aiProcessor');

const router = express.Router();

/**
 * POST /api/crawl
 * Start crawling one or more websites
 */
router.post('/', async (req, res) => {
  try {
    const { websites, maxDepth = 3, maxPages = 500, useSitemap = false, checkRedirectDuplicates = false } = req.body;
    
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
        useSitemap,
        checkRedirectDuplicates,
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
      'SELECT original_sitemap FROM sitemaps WHERE job_id = $1',
      [jobId]
    );
    
    // Get recommendations
    const recsResult = await pool.query(
      'SELECT * FROM ai_recommendations WHERE job_id = $1 ORDER BY created_at',
      [jobId]
    );
    
    // Generate prompts with sitemap data (if sitemap exists)
    let prompts = null;
    if (sitemapResult.rows[0] && sitemapResult.rows[0].original_sitemap) {
      try {
        // Try to get canonical tree and issues if available
        // For now, just pass the sitemap - the function will handle conversion
        prompts = generatePromptsWithData(sitemapResult.rows[0].original_sitemap);
        console.log('Generated prompts with sitemap data:', {
          hasImprovement: !!prompts.improvement,
        });
      } catch (error) {
        console.error('Error generating prompts:', error);
      }
    }
    
    // Only include prompts if they exist
    const responseData = {
      ...job,
      pagesCount: parseInt(pagesResult.rows[0].count),
      sitemap: sitemapResult.rows[0] ? { original_sitemap: sitemapResult.rows[0].original_sitemap } : null,
      recommendations: recsResult.rows || [],
    };
    
    // Add prompts if they exist
    if (prompts && prompts.improvement) {
      responseData.prompts = prompts;
    }
    
    res.json(responseData);
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
    
    // Check job status first
    const jobResult = await pool.query(
      'SELECT status FROM crawl_jobs WHERE id = $1',
      [jobId]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const jobStatus = jobResult.rows[0].status;
    const isActive = ['PENDING', 'CRAWLING', 'PROCESSING', 'AI_ANALYSIS'].includes(jobStatus);
    
    // Try to remove from queue (works for pending jobs)
    let queueRemoved = false;
    try {
      const queueJob = await crawlQueue.getJob(jobId);
      if (queueJob) {
        const state = await queueJob.getState();
        if (state === 'waiting' || state === 'delayed') {
          await queueJob.remove();
          queueRemoved = true;
          console.log(`✅ Removed job ${jobId} from queue (state: ${state})`);
        } else if (state === 'active') {
          // Job is actively being processed - try to mark it for cancellation
          // The crawler will check job existence and stop gracefully
          console.log(`⚠️ Job ${jobId} is active - will delete from DB, crawler will stop on next check`);
          // Note: BullMQ doesn't support cancelling active jobs directly
          // The crawler will detect the deletion and stop gracefully
        } else if (state === 'completed' || state === 'failed') {
          // Job already finished, just remove from queue
          await queueJob.remove();
          queueRemoved = true;
        }
      }
    } catch (queueError) {
      // Job might not be in queue anymore (already processed or never queued)
      console.log(`Job ${jobId} not found in queue, proceeding with DB deletion`);
    }
    
    // Delete from database (cascade will handle related records)
    // The crawler checks job existence periodically and will stop gracefully
    await pool.query('DELETE FROM crawl_jobs WHERE id = $1', [jobId]);
    console.log(`✅ Deleted job ${jobId} from database`);
    
    res.json({ 
      success: true,
      wasActive: isActive,
      message: isActive 
        ? 'Job deletion initiated. Active crawl will be stopped.' 
        : 'Job deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting crawl:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/crawl/:jobId/download/:format
 * Download sitemap in specified format (json, excel, tree)
 */
router.get('/:jobId/download/:format', async (req, res) => {
  try {
    const { jobId, format } = req.params;
    
    if (!['json', 'xml', 'excel', 'tree'].includes(format.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid format. Use json, xml, excel, or tree' });
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

/**
 * POST /api/crawl/:jobId/improve
 * Trigger AI improvement for a completed crawl job
 */
router.post('/:jobId/improve', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Check if job exists and is completed
    const jobResult = await pool.query(
      'SELECT * FROM crawl_jobs WHERE id = $1',
      [jobId]
    );
    
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    
    const job = jobResult.rows[0];
    
    if (job.status !== 'COMPLETED' && job.status !== 'PROCESSING') {
      return res.status(400).json({ error: 'Job must be completed before AI improvement can be applied' });
    }
    
    // Get sitemap
    const sitemapResult = await pool.query(
      'SELECT original_sitemap FROM sitemaps WHERE job_id = $1',
      [jobId]
    );
    
    if (sitemapResult.rows.length === 0 || !sitemapResult.rows[0].original_sitemap) {
      return res.status(400).json({ error: 'No sitemap available for improvement' });
    }
    
    const sitemap = sitemapResult.rows[0].original_sitemap;
    
    // Update status to AI_ANALYSIS
    await pool.query(
      'UPDATE crawl_jobs SET status = $1 WHERE id = $2',
      ['AI_ANALYSIS', jobId]
    );
    
    // Process with AI
    const { processSitemap } = require('../ai/aiProcessor');
    const { recommendations, prompts } = await processSitemap(jobId, sitemap);
    
    // Store recommendations
    for (const rec of recommendations) {
      await pool.query(
        'INSERT INTO ai_recommendations (job_id, category, before, after, explanation) VALUES ($1, $2, $3, $4, $5)',
        [jobId, rec.category, JSON.stringify(rec.before), JSON.stringify(rec.after), rec.explanation]
      );
    }
    
    // Store prompts - delete existing first, then insert new ones
    if (prompts && prompts.improvement) {
      try {
        // Delete existing prompts for this job
        await pool.query('DELETE FROM ai_prompts WHERE job_id = $1', [jobId]);
        
        // Store improvement prompt (single prompt)
        await pool.query(
          'INSERT INTO ai_prompts (job_id, prompt_type, chunk_index, system_prompt, user_prompt) VALUES ($1, $2, $3, $4, $5)',
          [jobId, 'improvement', null, prompts.improvement.systemPrompt, prompts.improvement.userPrompt]
        );
        console.log(`Stored improvement prompt for job ${jobId}`);
      } catch (error) {
        console.error('Error storing prompts (table might not exist - run migration):', error.message);
        // Don't fail the entire request if prompts can't be stored
      }
    }
    
    // Update status back to COMPLETED
    await pool.query(
      'UPDATE crawl_jobs SET status = $1 WHERE id = $2',
      ['COMPLETED', jobId]
    );
    
    res.json({ success: true, message: 'AI improvement completed' });
  } catch (error) {
    console.error('Error improving sitemap:', error);
    
    // Update status back to COMPLETED on error
    try {
      await pool.query(
        'UPDATE crawl_jobs SET status = $1 WHERE id = $2',
        ['COMPLETED', req.params.jobId]
      );
    } catch (e) {
      // Ignore error
    }
    
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

