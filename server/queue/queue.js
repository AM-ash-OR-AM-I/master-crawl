const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const { crawlWebsite } = require('../crawler/playwrightCrawler');
const { processSitemap } = require('../ai/aiProcessor');
const { pool, queryWithRetry } = require('../db/init');
const { broadcastStatusUpdate } = require('../websocket/websocket');
const { buildCanonicalSitemapTree } = require('../utils/sitemapTreeBuilder');
const { detectStructuralIssues } = require('../utils/issueDetector');

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
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
      await queryWithRetry(
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
          await queryWithRetry(
            'UPDATE crawl_jobs SET pages_crawled = $1 WHERE id = $2',
            [progress.pagesCrawled, jobId]
          );
          await broadcastStatusUpdate(jobId);
        }
      });
      
      // Update status to PROCESSING
      await queryWithRetry(
        'UPDATE crawl_jobs SET status = $1 WHERE id = $2',
        ['PROCESSING', jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      // Build sitemap structure (legacy format for backward compatibility)
      const legacySitemap = buildSitemapStructure(pages);
      
      // Build canonical sitemap tree (new format)
      const canonicalTree = buildCanonicalSitemapTree(pages);
      
      // Detect structural issues
      const structuralIssues = detectStructuralIssues(canonicalTree, pages);
      
      // Store original sitemap (legacy format for UI compatibility)
      await queryWithRetry(
        'INSERT INTO sitemaps (job_id, original_sitemap) VALUES ($1, $2) ON CONFLICT (job_id) DO UPDATE SET original_sitemap = $2',
        [jobId, JSON.stringify(legacySitemap)]
      );
      
      // Store canonical tree and issues in a metadata field (can be extended later)
      // For now, we'll store it alongside - in production you might want a separate table
      console.log(`📊 Sitemap analysis: ${canonicalTree._meta.total_pages} pages, max depth ${canonicalTree._meta.max_depth}, ${Object.keys(structuralIssues.duplication || {}).length} issue types detected`);
      
      // Update status to COMPLETED (AI improvement will be done manually via button)
      await queryWithRetry(
        'UPDATE crawl_jobs SET status = $1, completed_at = NOW() WHERE id = $2',
        ['COMPLETED', jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      return { success: true, pagesCount: pages.length };
    } catch (error) {
      console.error(`Error processing job ${jobId}:`, error);
      
      // Update status to FAILED
      await queryWithRetry(
        'UPDATE crawl_jobs SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3',
        ['FAILED', error.message, jobId]
      );
      await broadcastStatusUpdate(jobId);
      
      throw error;
    }
  },
  { 
    connection, 
    concurrency: parseInt(process.env.CRAWL_CONCURRENCY || '3'),
    lockDuration: 600000, // 10 minutes lock duration (increased from default 30s)
    maxStalledCount: 1,
    maxStalledCheckInterval: 30000, // Check for stalled jobs every 30 seconds
  }
);

crawlWorker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

crawlWorker.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

// Handle lock renewal errors gracefully (they're warnings, not critical failures)
crawlWorker.on('error', (err) => {
  if (err.message && err.message.includes('could not renew lock')) {
    // This is expected for long-running jobs, just log as warning
    console.warn(`⚠️ Lock renewal warning:`, err.message);
  } else {
    console.error(`❌ Worker error:`, err.message);
  }
});

async function initQueue() {
  console.log('✅ BullMQ queue initialized');
  return crawlQueue;
}

/**
 * Build sitemap tree structure (SitemapNode format like revize-ai)
 */
function buildSitemapStructure(pages) {
  if (!pages || pages.length === 0) {
    return {
      id: "root",
      url: "",
      title: "Root",
      depth: 0,
      children: [],
      status: "ok"
    };
  }
  
  // Clean up titles and ensure all pages are included
  const cleanedPages = pages.map((page, index) => {
    let title = page.title;
    // Clean up "ERROR: Error" titles
    if (!title || title === 'ERROR: Error' || title === 'Error' || title === 'ERROR' || title.startsWith('ERROR:')) {
      try {
        const urlObj = new URL(page.url);
        const hash = urlObj.hash?.substring(1);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        if (hash && hash.startsWith('/')) {
          title = hash.substring(1).split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
        } else if (hash) {
          title = hash.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
        } else {
          title = pathParts.length > 0 
            ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : 'Home';
        }
      } catch {
        title = 'Page';
      }
    }
    return {
      id: page.id || `page-${index}`,
      url: page.url,
      title: title,
      depth: page.depth,
      parentUrl: page.parentUrl,
      status: "ok"
    };
  });
  
  // Find root page (homepage)
  const rootPage = cleanedPages.find(p => {
    try {
      const u = new URL(p.url);
      return (u.pathname === '/' || u.pathname === '') && (!u.hash || u.hash === '' || u.hash === '#');
    } catch {
      return false;
    }
  }) || cleanedPages[0];
  
  // Separate regular pages from fragments
  const regularPages = [];
  const fragments = [];
  
  cleanedPages.forEach(page => {
    try {
      const urlObj = new URL(page.url);
      // Check if it's a fragment (has hash but not a hash route #/)
      const isFragment = urlObj.hash && urlObj.hash.length > 1 && !urlObj.hash.startsWith('#/');
      
      if (isFragment) {
        fragments.push(page);
      } else {
        regularPages.push(page);
      }
    } catch {
      // If URL parsing fails, treat as regular page
      regularPages.push(page);
    }
  });
  
  // Build a map of pages by URL for quick lookup
  const pageMap = new Map();
  regularPages.forEach(page => {
    pageMap.set(page.url, {
      ...page,
      children: [],
      fragments: [] // Store fragments here
    });
  });
  
  // Group fragments under their parent pages
  const virtualParents = new Map(); // Track virtual parents separately
  
  fragments.forEach(fragment => {
    try {
      const fragmentUrl = new URL(fragment.url);
      // Get parent URL (same URL without hash)
      const parentUrl = fragmentUrl.origin + fragmentUrl.pathname + (fragmentUrl.search || '');
      
      if (pageMap.has(parentUrl)) {
        const parent = pageMap.get(parentUrl);
        if (!parent.fragments) parent.fragments = [];
        parent.fragments.push({
          ...fragment,
          children: []
        });
      } else {
        // Parent page not found, create a virtual parent (but don't add to regularPages yet)
        if (!virtualParents.has(parentUrl)) {
          const virtualParent = {
            id: `virtual-${parentUrl}`,
            url: parentUrl,
            title: (() => {
              const pathParts = fragmentUrl.pathname.split('/').filter(p => p);
              return pathParts.length > 0 
                ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                : 'Home';
            })(),
            depth: fragment.depth,
            parentUrl: fragment.parentUrl,
            children: [],
            fragments: [],
            status: "ok",
            isVirtual: true
          };
          virtualParents.set(parentUrl, virtualParent);
        }
        const virtualParent = virtualParents.get(parentUrl);
        virtualParent.fragments.push({
          ...fragment,
          children: []
        });
      }
    } catch {
      // Skip invalid fragments
    }
  });
  
  // Add virtual parents to pageMap and regularPages (only if they don't already exist)
  virtualParents.forEach((virtualParent, parentUrl) => {
    if (!pageMap.has(parentUrl)) {
      pageMap.set(parentUrl, virtualParent);
      regularPages.push(virtualParent);
    }
  });
  
  // Build parent-child relationships
  const rootNodes = [];
  regularPages.forEach(page => {
    const node = pageMap.get(page.url);
    if (page.parentUrl && pageMap.has(page.parentUrl)) {
      const parent = pageMap.get(page.parentUrl);
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else if (page.url === rootPage?.url || (!page.parentUrl && page.depth === 0)) {
      rootNodes.push(node);
    } else {
      // Orphan page - add to root
      rootNodes.push(node);
    }
  });
  
  // If no root nodes found, use the first page
  if (rootNodes.length === 0 && cleanedPages.length > 0) {
    rootNodes.push(pageMap.get(cleanedPages[0].url));
  }
  
  // Build tree structure starting from root
  const buildNode = (pageNode) => {
    const node = {
      id: pageNode.id,
      url: pageNode.url,
      title: pageNode.title || pageNode.url,
      depth: pageNode.depth,
      status: pageNode.status || "ok"
    };
    
    // Combine regular children and fragments
    const allChildren = [];
    
    // Add fragments first (they should appear before regular children)
    if (pageNode.fragments && pageNode.fragments.length > 0) {
      pageNode.fragments.forEach(fragment => {
        const fragmentNode = {
          id: fragment.id,
          url: fragment.url,
          title: (() => {
            try {
              const urlObj = new URL(fragment.url);
              const hash = urlObj.hash.substring(1); // Remove #
              return hash.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Section';
            } catch {
              return fragment.title || 'Section';
            }
          })(),
          depth: fragment.depth,
          status: fragment.status || "ok",
          isFragment: true,
          children: []
        };
        allChildren.push(fragmentNode);
      });
    }
    
    // Add regular children
    if (pageNode.children && pageNode.children.length > 0) {
      const regularChildren = pageNode.children.map(buildNode);
      allChildren.push(...regularChildren);
    }
    
    if (allChildren.length > 0) {
      node.children = allChildren;
    }
    
    return node;
  };
  
  // Return root node with all children
  if (rootNodes.length === 1) {
    return buildNode(rootNodes[0]);
  } else {
    // Multiple root nodes - create a parent root
    return {
      id: "root",
      url: rootPage?.url || cleanedPages[0]?.url || "",
      title: "Root",
      depth: 0,
      status: "ok",
      children: rootNodes.map(buildNode)
    };
  }
}

module.exports = { crawlQueue, initQueue };

