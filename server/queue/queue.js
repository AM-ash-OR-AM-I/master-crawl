const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { crawlWebsite } = require('../crawler/puppeteerCrawler');
const { processSitemap } = require('../ai/aiProcessor');
const { pool } = require('../db/init');
const { broadcastStatusUpdate } = require('../websocket/websocket');

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
});

// Create queue
const crawlQueue = new Queue('crawl-queue', { connection });

// Worker to process crawl jobs
const crawlWorker = new Worker(
  'crawl-queue',
  async (job) => {
    const { jobId, domain, maxDepth, maxPages } = job.data;
    
    try {
      // Update status to CRAWLING
      await pool.query(
        'UPDATE crawl_jobs SET status = $1, started_at = NOW() WHERE id = $2',
        ['CRAWLING', jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      // Crawl the website
      const pages = await crawlWebsite({
        jobId,
        domain,
        maxDepth,
        maxPages,
        onProgress: async (progress) => {
          await pool.query(
            'UPDATE crawl_jobs SET pages_crawled = $1 WHERE id = $2',
            [progress.pagesCrawled, jobId]
          );
          await broadcastStatusUpdate(jobId);
        }
      });
      
      // Update status to PROCESSING
      await pool.query(
        'UPDATE crawl_jobs SET status = $1 WHERE id = $2',
        ['PROCESSING', jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      // Build sitemap structure
      const sitemap = buildSitemapStructure(pages);
      
      // Store original sitemap
      await pool.query(
        'INSERT INTO sitemaps (job_id, original_sitemap) VALUES ($1, $2) ON CONFLICT (job_id) DO UPDATE SET original_sitemap = $2',
        [jobId, JSON.stringify(sitemap)]
      );
      
      // Update status to AI_ANALYSIS
      await pool.query(
        'UPDATE crawl_jobs SET status = $1 WHERE id = $2',
        ['AI_ANALYSIS', jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      // Process with AI
      const { optimizedSitemap, recommendations } = await processSitemap(jobId, sitemap);
      
      // Store optimized sitemap and recommendations
      await pool.query(
        'UPDATE sitemaps SET optimized_sitemap = $1 WHERE job_id = $2',
        [JSON.stringify(optimizedSitemap), jobId]
      );
      
      // Store recommendations
      for (const rec of recommendations) {
        await pool.query(
          'INSERT INTO ai_recommendations (job_id, category, before, after, explanation) VALUES ($1, $2, $3, $4, $5)',
          [jobId, rec.category, JSON.stringify(rec.before), JSON.stringify(rec.after), rec.explanation]
        );
      }
      
      // Update status to COMPLETED
      await pool.query(
        'UPDATE crawl_jobs SET status = $1, completed_at = NOW() WHERE id = $2',
        ['COMPLETED', jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      return { success: true, pagesCount: pages.length };
    } catch (error) {
      console.error(`Error processing job ${jobId}:`, error);
      
      // Update status to FAILED
      await pool.query(
        'UPDATE crawl_jobs SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3',
        ['FAILED', error.message, jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      throw error;
    }
  },
  { connection, concurrency: parseInt(process.env.CRAWL_CONCURRENCY || '3') }
);

crawlWorker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

crawlWorker.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

async function initQueue() {
  console.log('✅ BullMQ queue initialized');
  return crawlQueue;
}

function buildSitemapStructure(pages) {
  const structure = {};
  
  for (const page of pages) {
    const url = new URL(page.url);
    const pathParts = url.pathname.split('/').filter(p => p);
    const hasHash = url.hash && url.hash !== '';
    
    // Handle hash URLs - include them in structure
    if (hasHash && pathParts.length === 0) {
      // Hash URL on homepage
      if (!structure._hash) {
        structure._hash = {
          _count: 0,
          _depth: 0,
          _urls: []
        };
      }
      structure._hash._count++;
      structure._hash._urls.push({
        url: page.url,
        title: page.title,
        depth: page.depth
      });
      continue;
    }
    
    let current = structure;
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      if (!current[part]) {
        current[part] = {
          _count: 0,
          _depth: i + 1,
          _urls: []
        };
      }
      current[part]._count++;
      if (i === pathParts.length - 1) {
        current[part]._urls.push({
          url: page.url,
          title: page.title,
          depth: page.depth
        });
        
        // If this path has a hash, also add it as a hash entry
        if (hasHash) {
          const hashKey = part + '_hash';
          if (!current[hashKey]) {
            current[hashKey] = {
              _count: 0,
              _depth: i + 1,
              _urls: []
            };
          }
          current[hashKey]._count++;
          current[hashKey]._urls.push({
            url: page.url,
            title: page.title,
            depth: page.depth
          });
        }
      }
      current = current[part];
    }
  }
  
  return structure;
}

module.exports = { crawlQueue, initQueue };

