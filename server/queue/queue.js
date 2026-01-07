const { Queue, Worker } = require("bullmq");
const Redis = require("ioredis");
const { crawlWebsite } = require("../crawler/playwrightCrawler");
const { processSitemap } = require("../ai/aiProcessor");
const { pool, queryWithRetry } = require("../db/init");
const { broadcastStatusUpdate } = require("../websocket/websocket");
const { buildCanonicalSitemapTree } = require("../utils/sitemapTreeBuilder");
const { detectStructuralIssues } = require("../utils/issueDetector");

const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    const targetError = "READONLY";
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
});

// Create queue
const crawlQueue = new Queue("crawl-queue", { connection });

// Worker to process crawl jobs
const crawlWorker = new Worker(
  "crawl-queue",
  async (job) => {
    const {
      jobId,
      domain,
      maxDepth,
      maxPages,
      useSitemap = false,
      checkRedirectDuplicates = false,
    } = job.data;

    try {
      // Update status to CRAWLING
      await queryWithRetry(
        "UPDATE crawl_jobs SET status = $1, started_at = NOW() WHERE id = $2",
        ["CRAWLING", jobId]
      );
      await broadcastStatusUpdate(jobId);

      // Crawl the website
      const pages = await crawlWebsite({
        jobId,
        domain,
        maxDepth,
        maxPages,
        useSitemap,
        checkRedirectDuplicates: checkRedirectDuplicates,
        onProgress: async (progress) => {
          await queryWithRetry(
            "UPDATE crawl_jobs SET pages_crawled = $1 WHERE id = $2",
            [progress.pagesCrawled, jobId]
          );
          await broadcastStatusUpdate(jobId);
        },
      });

      // Extract crawl stats and errors from the result
      const crawlStats = pages._crawlStats || {};
      const crawlErrors = pages._crawlErrors || {};

      // Check if crawl had critical errors
      if (crawlErrors.criticalError) {
        console.warn(
          `⚠️ Crawl completed with critical error: ${crawlErrors.criticalError}`
        );
      }

      // Log crawl summary
      if (crawlStats.failedPages > 0) {
        console.log(
          `📊 Crawl stats: ${crawlStats.successfulPages} successful, ${crawlStats.failedPages} failed, ${crawlStats.skippedPages} skipped`
        );
        if (crawlStats.sitemapUsed) {
          console.log(
            `   📍 Used sitemap.xml (discovered ${crawlStats.sitemapUrlsDiscovered} URLs)`
          );
        }
      }

      // Update status to PROCESSING
      await queryWithRetry("UPDATE crawl_jobs SET status = $1 WHERE id = $2", [
        "PROCESSING",
        jobId,
      ]);
      await broadcastStatusUpdate(jobId);

      // Build sitemap structure (legacy format for backward compatibility)
      const legacySitemap = buildSitemapStructure(pages);

      // Build canonical sitemap tree (new format)
      const canonicalTree = buildCanonicalSitemapTree(pages);

      // Detect structural issues
      const structuralIssues = detectStructuralIssues(canonicalTree, pages);

      // Add crawl errors/warnings to the sitemap metadata
      if (legacySitemap) {
        legacySitemap._crawlMeta = {
          stats: crawlStats,
          hasErrors: crawlErrors.pageErrors?.length > 0,
          errorCount: crawlErrors.pageErrors?.length || 0,
          warnings: crawlErrors.warnings || [],
          sitemapUsed: crawlStats.sitemapUsed || false,
          stopReason: crawlStats.stopReason || "completed",
          skippedPdfs: crawlStats.skippedPdfs || 0,
          skippedFiles: crawlErrors.skippedFiles || [],
        };
      }

      // Store original sitemap (legacy format for UI compatibility)
      await queryWithRetry(
        "INSERT INTO sitemaps (job_id, original_sitemap) VALUES ($1, $2) ON CONFLICT (job_id) DO UPDATE SET original_sitemap = $2",
        [jobId, JSON.stringify(legacySitemap)]
      );

      // Store canonical tree and issues in a metadata field (can be extended later)
      // For now, we'll store it alongside - in production you might want a separate table
      console.log(
        `📊 Sitemap analysis: ${
          canonicalTree._meta.total_pages
        } pages, max depth ${canonicalTree._meta.max_depth}, ${
          Object.keys(structuralIssues.duplication || {}).length
        } issue types detected`
      );

      // Build error message summary if there were issues
      let errorSummary = null;
      if (crawlErrors.criticalError) {
        errorSummary = crawlErrors.criticalError;
      } else if (crawlErrors.pageErrors?.length > 0) {
        const failedCount = crawlErrors.pageErrors.length;
        errorSummary = `${failedCount} page(s) failed to crawl. ${crawlStats.successfulPages} pages crawled successfully.`;
      }

      // Update status to COMPLETED (AI improvement will be done manually via button)
      // Include error summary if there were partial failures
      if (errorSummary && !crawlErrors.criticalError) {
        await queryWithRetry(
          "UPDATE crawl_jobs SET status = $1, completed_at = NOW(), error_message = $2 WHERE id = $3",
          ["COMPLETED", errorSummary, jobId]
        );
      } else {
        await queryWithRetry(
          "UPDATE crawl_jobs SET status = $1, completed_at = NOW() WHERE id = $2",
          ["COMPLETED", jobId]
        );
      }
      await broadcastStatusUpdate(jobId);

      return {
        success: true,
        pagesCount: pages.length,
        stats: crawlStats,
        hasErrors: crawlErrors.pageErrors?.length > 0,
      };
    } catch (error) {
      console.error(`Error processing job ${jobId}:`, error);

      // Build detailed error message
      let errorMessage = error.message;
      if (error.message.includes("net::ERR_")) {
        errorMessage = `Network error: ${error.message}. The website may be unreachable or blocking crawlers.`;
      } else if (error.message.includes("timeout")) {
        errorMessage = `Timeout error: ${error.message}. The website may be too slow or unresponsive.`;
      } else if (error.message.includes("navigation")) {
        errorMessage = `Navigation error: ${error.message}. The website may have redirects or access restrictions.`;
      }

      // Update status to FAILED
      await queryWithRetry(
        "UPDATE crawl_jobs SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3",
        ["FAILED", errorMessage, jobId]
      );
      await broadcastStatusUpdate(jobId);

      throw error;
    }
  },
  {
    connection,
    concurrency: parseInt(process.env.CRAWL_CONCURRENCY || "3"),
    lockDuration: 600000, // 10 minutes lock duration (increased from default 30s)
    maxStalledCount: 1,
    maxStalledCheckInterval: 30000, // Check for stalled jobs every 30 seconds
    // Don't retry failed jobs - programming errors won't fix themselves
    // and crawl failures should be investigated, not auto-retried
  }
);

// Also configure the queue to not retry by default
crawlQueue.defaultJobOptions = {
  attempts: 1, // Only try once, no retries
  removeOnComplete: 100, // Keep last 100 completed jobs
  removeOnFail: 100, // Keep last 100 failed jobs
};

crawlWorker.on("completed", (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

crawlWorker.on("failed", (job, err) => {
  console.error(`❌ Job ${job.id} failed:`, err.message);
});

// Handle lock renewal errors gracefully (they're warnings, not critical failures)
crawlWorker.on("error", (err) => {
  if (err.message && err.message.includes("could not renew lock")) {
    // This is expected for long-running jobs, just log as warning
    console.warn(`⚠️ Lock renewal warning:`, err.message);
  } else {
    console.error(`❌ Worker error:`, err.message);
  }
});

async function initQueue() {
  console.log("✅ BullMQ queue initialized");
  return crawlQueue;
}

/**
 * Build a path-based tree structure for large sitemaps
 * Groups URLs by path segments to avoid deep recursion
 */
function buildPathBasedTree(pages, maxChildrenPerNode = 100, maxDepth = 4) {
  // Group pages by their first path segment
  const groups = new Map();
  let rootUrl = "";

  for (const page of pages) {
    try {
      const urlObj = new URL(page.url);
      if (!rootUrl) rootUrl = `${urlObj.protocol}//${urlObj.host}`;

      const pathParts = urlObj.pathname.split("/").filter((p) => p);
      const firstSegment = pathParts[0] || "/";

      if (!groups.has(firstSegment)) {
        groups.set(firstSegment, []);
      }
      groups.get(firstSegment).push(page);
    } catch {
      // Skip invalid URLs
    }
  }

  // Build tree iteratively (non-recursive)
  const buildGroupNode = (groupName, groupPages, depth) => {
    if (depth >= maxDepth || groupPages.length <= maxChildrenPerNode) {
      // Leaf level - just list pages directly
      const children = groupPages
        .slice(0, maxChildrenPerNode)
        .map((page, idx) => {
          let title = page.title;
          if (!title || title.startsWith("ERROR")) {
            try {
              const urlObj = new URL(page.url);
              const pathParts = urlObj.pathname.split("/").filter((p) => p);
              title =
                pathParts.length > 0
                  ? pathParts[pathParts.length - 1]
                      .replace(/-/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase())
                  : "Page";
            } catch {
              title = "Page";
            }
          }
          return {
            id: page.id || `page-${idx}`,
            url: page.url,
            title: title,
            depth: depth + 1,
            status: "ok",
          };
        });

      // Add summary if truncated
      if (groupPages.length > maxChildrenPerNode) {
        children.push({
          id: `${groupName}-more`,
          url: "",
          title: `... and ${groupPages.length - maxChildrenPerNode} more pages`,
          depth: depth + 1,
          status: "info",
          isSummary: true,
        });
      }

      return {
        id: `group-${groupName}`,
        url: groupPages[0]?.url || "",
        title:
          groupName === "/"
            ? "Home"
            : groupName
                .replace(/-/g, " ")
                .replace(/\b\w/g, (l) => l.toUpperCase()),
        depth: depth,
        status: "ok",
        children: children,
        pageCount: groupPages.length,
      };
    }

    // Sub-group by next path segment
    const subGroups = new Map();
    for (const page of groupPages) {
      try {
        const urlObj = new URL(page.url);
        const pathParts = urlObj.pathname.split("/").filter((p) => p);
        const nextSegment = pathParts[depth] || "_root";

        if (!subGroups.has(nextSegment)) {
          subGroups.set(nextSegment, []);
        }
        subGroups.get(nextSegment).push(page);
      } catch {
        // Skip
      }
    }

    // Build children for each sub-group
    const children = [];
    let count = 0;
    for (const [subGroupName, subGroupPages] of subGroups) {
      if (count >= maxChildrenPerNode) {
        children.push({
          id: `${groupName}-more-groups`,
          url: "",
          title: `... and ${subGroups.size - count} more sections`,
          depth: depth + 1,
          status: "info",
          isSummary: true,
        });
        break;
      }
      children.push(buildGroupNode(subGroupName, subGroupPages, depth + 1));
      count++;
    }

    return {
      id: `group-${groupName}`,
      url: groupPages[0]?.url || "",
      title:
        groupName === "/"
          ? "Home"
          : groupName
              .replace(/-/g, " ")
              .replace(/\b\w/g, (l) => l.toUpperCase()),
      depth: depth,
      status: "ok",
      children: children,
      pageCount: groupPages.length,
    };
  };

  // Build root with top-level groups
  const rootChildren = [];
  let count = 0;
  for (const [groupName, groupPages] of groups) {
    if (count >= maxChildrenPerNode) {
      rootChildren.push({
        id: "root-more",
        url: "",
        title: `... and ${groups.size - count} more sections (${
          pages.length
        } total pages)`,
        depth: 1,
        status: "info",
        isSummary: true,
      });
      break;
    }
    rootChildren.push(buildGroupNode(groupName, groupPages, 1));
    count++;
  }

  return {
    id: "root",
    url: rootUrl,
    title: "Root",
    depth: 0,
    status: "ok",
    children: rootChildren,
    pageCount: pages.length,
  };
}

/**
 * Build sitemap tree structure using actual parent-child relationships from crawl data
 * This reflects the true link hierarchy discovered during crawling
 */
function buildSitemapStructure(pages) {
  if (!pages || pages.length === 0) {
    return {
      id: "root",
      url: "",
      title: "Root",
      depth: 0,
      children: [],
      status: "ok",
    };
  }

  console.log(
    `📊 Building tree from crawl relationships for ${pages.length} pages`
  );

  // Find root URL (homepage)
  let rootUrl = "";
  const rootPage =
    pages.find((p) => {
      try {
        const u = new URL(p.url);
        return (
          (u.pathname === "/" || u.pathname === "") &&
          (!u.hash || u.hash === "" || u.hash === "#")
        );
      } catch {
        return false;
      }
    }) ||
    pages.find((p) => p.depth === 0) ||
    pages[0];

  if (rootPage) {
    try {
      const urlObj = new URL(rootPage.url);
      rootUrl = `${urlObj.protocol}//${urlObj.host}`;
    } catch {
      rootUrl = rootPage.url;
    }
  }

  // Build a map of pages by URL for quick lookup
  const pageMap = new Map();
  pages.forEach((page, idx) => {
    // Clean up title
    let title = page.title;
    if (
      !title ||
      title === "ERROR: Error" ||
      title === "Error" ||
      title === "ERROR" ||
      title.startsWith("ERROR:")
    ) {
      try {
        const urlObj = new URL(page.url);
        const pathParts = urlObj.pathname.split("/").filter((p) => p);
        title =
          pathParts.length > 0
            ? pathParts[pathParts.length - 1]
                .replace(/-/g, " ")
                .replace(/\b\w/g, (l) => l.toUpperCase())
            : "Home";
      } catch {
        title = "Page";
      }
    }

    pageMap.set(page.url, {
      id: page.id || `page-${idx}`,
      url: page.url,
      title: title,
      depth: page.depth || 0,
      parentUrl: page.parentUrl,
      status: "ok",
      children: [],
    });
  });

  // Build parent-child relationships based on crawl data
  const rootNodes = [];

  for (const page of pages) {
    const node = pageMap.get(page.url);

    // If page has a parent and parent exists in our map, add as child
    if (page.parentUrl && pageMap.has(page.parentUrl)) {
      const parent = pageMap.get(page.parentUrl);
      parent.children.push(node);
    } else if (page.depth === 0 || !page.parentUrl) {
      // Root level pages (depth 0 or no parent)
      rootNodes.push(node);
    } else {
      // Orphan page (parent not crawled) - add to root
      rootNodes.push(node);
    }
  }

  // Sort children by depth then title for consistent ordering
  const sortChildren = (node) => {
    if (node.children && node.children.length > 0) {
      node.children.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        return (a.title || "").localeCompare(b.title || "");
      });
      node.children.forEach(sortChildren);
    }
  };

  // Sort root nodes and their children
  rootNodes.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return (a.title || "").localeCompare(b.title || "");
  });
  rootNodes.forEach(sortChildren);

  // If only one root node, return it directly
  if (rootNodes.length === 1) {
    return rootNodes[0];
  }

  // Multiple root nodes - wrap in a container
  return {
    id: "root",
    url: rootUrl,
    title: "Root",
    depth: 0,
    status: "ok",
    children: rootNodes,
    pageCount: pages.length,
  };
}

module.exports = { crawlQueue, initQueue };
