const { chromium } = require("playwright");
const robotsParser = require("robots-parser");
const { URL } = require("url");
const { pool, queryWithRetry } = require("../db/init");

/**
 * Check if a crawl job still exists in the database
 * Returns true if job exists, false otherwise
 */
async function jobExists(jobId) {
  try {
    const result = await queryWithRetry(
      "SELECT id FROM crawl_jobs WHERE id = $1",
      [jobId]
    );
    return result.rows.length > 0;
  } catch (error) {
    // If query fails, assume job doesn't exist to be safe
    console.warn(`Error checking job existence for ${jobId}:`, error.message);
    return false;
  }
}

// Browser is created fresh for each crawl job to ensure clean state
// and proper resource cleanup

// Configuration constants
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // Base delay in ms
const REQUEST_DELAY_MIN = 500; // Minimum delay between requests
const REQUEST_DELAY_MAX = 2000; // Maximum delay between requests
const SPA_WAIT_TIMEOUT = 5000; // Max wait for SPA content
const PAGE_NAVIGATION_TIMEOUT = 30000; // Increased timeout

/**
 * Normalize URL - preserve hash for SPAs and fragments, remove query params
 * NOTE: We preserve trailing slashes as some servers require them (return 404 without)
 */
function normalizeUrl(url, preserveHash = false) {
  try {
    const u = new URL(url);
    // For SPAs, preserve hash routes (hash starting with #/)
    // Also preserve hash fragments (like #section-name) for page sections
    if (!preserveHash) {
      // Check if it's a hash route (#/) or a meaningful fragment
      const isHashRoute = u.hash && u.hash.startsWith("#/");
      const isFragment =
        u.hash && u.hash.length > 1 && !u.hash.startsWith("#/");

      // Only remove hash if it's not a route or fragment
      if (!isHashRoute && !isFragment) {
        u.hash = "";
      }
    }
    u.search = "";
    // Preserve trailing slash - some servers require it (e.g., return 404 without it)
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Get base URL without hash fragment (except #/ routes for SPAs)
 * Used to check if parent page exists before crawling hash fragment URLs
 */
function getBaseUrl(url) {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    // Preserve hash routes (SPA routing like #/route)
    if (urlObj.hash && urlObj.hash.startsWith("#/")) {
      // Keep hash routes as-is - they're different pages
      return urlObj.href;
    }
    // Remove hash fragments (like #section-name) - they're client-side only
    urlObj.hash = "";
    return urlObj.href;
  } catch {
    return url;
  }
}

/**
 * Get canonical URL for deduplication (without trailing slash)
 * Used only for checking if we've already visited a URL
 */
function getCanonicalUrl(url) {
  if (!url) return null;
  return url.replace(/\/$/, "");
}

/**
 * Check if URL has been visited (handles both with/without trailing slash)
 */
function hasVisited(visited, url) {
  if (!url) return true;
  const canonical = getCanonicalUrl(url);
  return (
    visited.has(url) || visited.has(canonical) || visited.has(canonical + "/")
  );
}

/**
 * Mark URL as visited (stores canonical form)
 */
function markVisited(visited, url) {
  if (!url) return;
  // Store the canonical form (without trailing slash) for consistent deduplication
  visited.add(getCanonicalUrl(url));
}

/**
 * Check if two URLs are from the same domain
 */
function sameDomain(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * Check if two URLs are from the same site (handles subdomains)
 * e.g., www.doordash.com and about.doordash.com are considered same site
 */
function sameSite(a, b) {
  try {
    const hostnameA = new URL(a).hostname;
    const hostnameB = new URL(b).hostname;

    // Exact match
    if (hostnameA === hostnameB) return true;

    // Extract root domain (e.g., "doordash.com" from "www.doordash.com" or "about.doordash.com")
    const getRootDomain = (hostname) => {
      const parts = hostname.split(".");
      // Handle cases like "co.uk", "com.au" etc. (2-part TLDs)
      if (parts.length >= 3) {
        // Check for known 2-part TLDs
        const twoPartTlds = [
          "co.uk",
          "com.au",
          "com.br",
          "co.za",
          "com.mx",
          "co.jp",
        ];
        const lastTwo = parts.slice(-2).join(".");
        if (twoPartTlds.includes(lastTwo)) {
          return parts.slice(-3).join(".");
        }
      }
      // Standard case: last 2 parts (e.g., "doordash.com")
      return parts.slice(-2).join(".");
    };

    const rootA = getRootDomain(hostnameA);
    const rootB = getRootDomain(hostnameB);

    return rootA === rootB;
  } catch {
    return false;
  }
}

/**
 * Select a diverse sample of URLs from a large sitemap
 * Prioritizes: homepage, then spreads across different path prefixes
 */
function selectSampleUrls(urls, sampleSize) {
  if (urls.length <= sampleSize) {
    return urls;
  }

  const selected = new Set();
  const pathPrefixes = new Map(); // Track URLs by their first path segment

  // First, find and add the homepage
  for (const url of urls) {
    try {
      const urlObj = new URL(url);
      if (urlObj.pathname === "/" || urlObj.pathname === "") {
        selected.add(url);
        break;
      }
    } catch {}
  }

  // Group URLs by their first path segment
  for (const url of urls) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/").filter((p) => p);
      const prefix = pathParts[0] || "root";

      if (!pathPrefixes.has(prefix)) {
        pathPrefixes.set(prefix, []);
      }
      pathPrefixes.get(prefix).push(url);
    } catch {}
  }

  // Distribute sample across path prefixes
  const prefixArray = Array.from(pathPrefixes.entries());
  let round = 0;

  while (selected.size < sampleSize && round < 100) {
    for (const [prefix, prefixUrls] of prefixArray) {
      if (selected.size >= sampleSize) break;

      // Pick one URL from each prefix per round
      const urlIndex = round % prefixUrls.length;
      const url = prefixUrls[urlIndex];

      if (!selected.has(url)) {
        selected.add(url);
      }
    }
    round++;
  }

  return Array.from(selected);
}

/**
 * Load robots.txt
 */
async function loadRobots(url) {
  try {
    const https = require("https");
    const http = require("http");
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;

    return new Promise((resolve) => {
      const client = u.protocol === "https:" ? https : http;
      const req = client.get(robotsUrl, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const robots = robotsParser(robotsUrl, data);
            console.log("🤖 robots.txt loaded");
            resolve(robots);
          } catch {
            resolve({ isAllowed: () => true, getSitemaps: () => [] });
          }
        });
      });
      req.on("error", () => {
        console.log("⚠️ robots.txt not found, crawling allowed");
        resolve({ isAllowed: () => true, getSitemaps: () => [] });
      });
      req.setTimeout(5000, () => {
        req.destroy();
        console.log("⚠️ robots.txt timeout, crawling allowed");
        resolve({ isAllowed: () => true, getSitemaps: () => [] });
      });
    });
  } catch {
    console.log("⚠️ robots.txt not found, crawling allowed");
    return { isAllowed: () => true, getSitemaps: () => [] };
  }
}

/**
 * Fetch and parse sitemap.xml to discover URLs
 * Supports multiple formats:
 * - Standard XML sitemaps (urlset with loc tags)
 * - Sitemap index files (sitemapindex)
 * - Gzipped sitemaps (.xml.gz)
 * - RSS/Atom feeds as sitemaps
 * - Plain text sitemaps (one URL per line)
 * - Sitemaps with namespaces (xmlns)
 */
async function fetchSitemap(baseUrl, robots = null) {
  const https = require("https");
  const http = require("http");
  const zlib = require("zlib");

  const discoveredUrls = new Set();
  const errors = [];
  const processedSitemaps = new Set(); // Track processed sitemaps to avoid duplicates

  // Get sitemap URLs from robots.txt or use defaults
  let sitemapUrls = [];
  const baseUrlObj = new URL(baseUrl);

  if (robots && typeof robots.getSitemaps === "function") {
    try {
      const robotsSitemaps = robots.getSitemaps() || [];
      if (robotsSitemaps.length > 0) {
        console.log(
          `📍 Found ${robotsSitemaps.length} sitemap(s) in robots.txt`
        );
        // Resolve relative URLs to absolute URLs
        for (const sitemapUrl of robotsSitemaps) {
          try {
            // Check if it's already absolute
            if (
              sitemapUrl.startsWith("http://") ||
              sitemapUrl.startsWith("https://")
            ) {
              sitemapUrls.push(sitemapUrl);
            } else {
              // It's relative - resolve against base URL
              const absoluteUrl = new URL(sitemapUrl, baseUrl).href;
              sitemapUrls.push(absoluteUrl);
              console.log(
                `   ↪️ Resolved relative sitemap: ${sitemapUrl} -> ${absoluteUrl}`
              );
            }
          } catch (e) {
            console.warn(
              `   ⚠️ Invalid sitemap URL in robots.txt: ${sitemapUrl}`
            );
          }
        }
      }
    } catch {
      // Ignore errors getting sitemaps from robots
    }
  }

  // Add default sitemap locations if none found in robots.txt
  if (sitemapUrls.length === 0) {
    sitemapUrls = [
      `${baseUrlObj.origin}/sitemap.xml`,
      `${baseUrlObj.origin}/sitemap_index.xml`,
      `${baseUrlObj.origin}/sitemap-index.xml`,
      `${baseUrlObj.origin}/sitemap.xml.gz`,
      `${baseUrlObj.origin}/sitemaps.xml`,
      `${baseUrlObj.origin}/sitemap1.xml`,
      `${baseUrlObj.origin}/post-sitemap.xml`,
      `${baseUrlObj.origin}/page-sitemap.xml`,
    ];
  }

  /**
   * Extract URLs from XML content using multiple patterns
   * Handles various sitemap formats including those with namespaces
   */
  function extractUrlsFromXml(content) {
    const urls = [];

    // Pattern 1: Standard <loc> tags (handles namespaces too)
    // Matches: <loc>url</loc>, <ns:loc>url</ns:loc>, etc.
    const locPattern =
      /<(?:[a-z0-9]+:)?loc[^>]*>([^<]+)<\/(?:[a-z0-9]+:)?loc>/gi;
    let match;
    while ((match = locPattern.exec(content)) !== null) {
      const url = match[1].trim();
      if (url) {
        // Decode HTML entities
        const decodedUrl = url
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        urls.push(decodedUrl);
      }
    }

    // Pattern 2: CDATA sections within loc tags
    const cdataPattern =
      /<(?:[a-z0-9]+:)?loc[^>]*>\s*<!\[CDATA\[([^\]]+)\]\]>\s*<\/(?:[a-z0-9]+:)?loc>/gi;
    while ((match = cdataPattern.exec(content)) !== null) {
      const url = match[1].trim();
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }

    // Pattern 3: RSS/Atom feed links
    const linkPattern = /<link[^>]*>([^<]+)<\/link>/gi;
    while ((match = linkPattern.exec(content)) !== null) {
      const url = match[1].trim();
      if (url && url.startsWith("http") && !urls.includes(url)) {
        urls.push(url);
      }
    }

    // Pattern 4: Atom href attributes
    const hrefPattern = /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/gi;
    while ((match = hrefPattern.exec(content)) !== null) {
      const url = match[1].trim();
      if (url && url.startsWith("http") && !urls.includes(url)) {
        urls.push(url);
      }
    }

    return urls;
  }

  /**
   * Extract sitemap URLs from sitemap index
   */
  function extractSitemapsFromIndex(content) {
    const sitemaps = [];

    // Pattern for sitemap index entries
    const locPattern =
      /<(?:[a-z0-9]+:)?loc[^>]*>([^<]+)<\/(?:[a-z0-9]+:)?loc>/gi;
    let match;
    while ((match = locPattern.exec(content)) !== null) {
      const url = match[1]
        .trim()
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      if (
        (url && url.includes("sitemap")) ||
        url.endsWith(".xml") ||
        url.endsWith(".xml.gz")
      ) {
        sitemaps.push(url);
      } else if (url.startsWith("http")) {
        // Could be a sitemap URL without 'sitemap' in name
        sitemaps.push(url);
      }
    }

    return sitemaps;
  }

  /**
   * Check if content is a sitemap index
   */
  function isSitemapIndex(content) {
    const lowerContent = content.toLowerCase();
    return (
      lowerContent.includes("<sitemapindex") ||
      lowerContent.includes(":sitemapindex") ||
      (lowerContent.includes("<sitemap>") &&
        lowerContent.includes("</sitemap>"))
    );
  }

  /**
   * Check if content is a URL set sitemap
   */
  function isUrlSetSitemap(content) {
    const lowerContent = content.toLowerCase();
    return (
      lowerContent.includes("<urlset") ||
      lowerContent.includes(":urlset") ||
      (lowerContent.includes("<url>") && lowerContent.includes("<loc>"))
    );
  }

  /**
   * Parse plain text sitemap (one URL per line)
   */
  function parseTextSitemap(content) {
    const urls = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.startsWith("http")) {
        try {
          new URL(trimmed);
          urls.push(trimmed);
        } catch {
          // Skip invalid URLs
        }
      }
    }
    return urls;
  }

  /**
   * Fetch a single sitemap URL
   */
  async function fetchSingleSitemap(sitemapUrl, depth = 0) {
    // Prevent infinite recursion
    if (depth > 5) {
      console.warn(`⚠️ Sitemap depth limit reached for ${sitemapUrl}`);
      return;
    }

    // Skip if already processed
    if (processedSitemaps.has(sitemapUrl)) {
      return;
    }
    processedSitemaps.add(sitemapUrl);

    return new Promise((resolve) => {
      try {
        const u = new URL(sitemapUrl);
        const client = u.protocol === "https:" ? https : http;
        const isGzipped = sitemapUrl.endsWith(".gz");

        const requestOptions = {
          hostname: u.hostname,
          port: u.port || (u.protocol === "https:" ? 443 : 80),
          path: u.pathname + u.search,
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; SitemapCrawler/1.0)",
            Accept: "application/xml, text/xml, text/plain, */*",
            "Accept-Encoding": isGzipped ? "gzip" : "gzip, deflate",
          },
        };

        const req = client.request(requestOptions, (res) => {
          // Handle redirects (up to 5)
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            const redirectUrl = res.headers.location.startsWith("http")
              ? res.headers.location
              : new URL(res.headers.location, sitemapUrl).href;
            console.log(`↪️ Sitemap redirect: ${sitemapUrl} -> ${redirectUrl}`);
            fetchSingleSitemap(redirectUrl, depth).then(resolve);
            return;
          }

          if (res.statusCode !== 200) {
            resolve(); // Silently skip non-existent sitemaps
            return;
          }

          let data = [];

          // Handle gzip encoding (either from URL or content-encoding)
          const contentEncoding = res.headers["content-encoding"];
          const shouldDecompress = isGzipped || contentEncoding === "gzip";
          const stream = shouldDecompress ? res.pipe(zlib.createGunzip()) : res;

          stream.on("data", (chunk) => data.push(chunk));
          stream.on("error", (err) => {
            // Try without decompression if gzip fails
            if (shouldDecompress && err.code === "Z_DATA_ERROR") {
              console.warn(
                `⚠️ Gzip decompression failed for ${sitemapUrl}, trying raw content`
              );
              // Re-fetch without decompression
              data = [];
              res.on("data", (chunk) => data.push(chunk));
            } else {
              errors.push({
                url: sitemapUrl,
                error: `Stream error: ${err.message}`,
              });
              resolve();
            }
          });
          stream.on("end", async () => {
            try {
              const content = Buffer.concat(data).toString("utf8");

              // Skip empty content
              if (!content || content.trim().length === 0) {
                resolve();
                return;
              }

              // Detect sitemap type and parse accordingly
              if (isSitemapIndex(content)) {
                // It's a sitemap index - extract child sitemaps
                const childSitemaps = extractSitemapsFromIndex(content);
                console.log(
                  `📂 Sitemap index found with ${childSitemaps.length} child sitemaps: ${sitemapUrl}`
                );

                // Recursively fetch child sitemaps (limit to first 20)
                for (const childUrl of childSitemaps.slice(0, 20)) {
                  try {
                    // Resolve relative URLs
                    const absoluteUrl = childUrl.startsWith("http")
                      ? childUrl
                      : new URL(childUrl, sitemapUrl).href;
                    await fetchSingleSitemap(absoluteUrl, depth + 1);
                  } catch (e) {
                    errors.push({
                      url: childUrl,
                      error: `Invalid URL: ${e.message}`,
                    });
                  }
                }
              } else if (isUrlSetSitemap(content)) {
                // Regular XML sitemap - extract URLs
                const urls = extractUrlsFromXml(content);

                urls.forEach((url) => {
                  try {
                    // Validate and normalize URL
                    const urlObj = new URL(url);
                    discoveredUrls.add(urlObj.href);
                  } catch {
                    // Try to resolve relative URLs
                    try {
                      const absoluteUrl = new URL(url, sitemapUrl).href;
                      discoveredUrls.add(absoluteUrl);
                    } catch {
                      // Skip invalid URLs
                    }
                  }
                });

                if (urls.length > 0) {
                  console.log(
                    `📄 Sitemap parsed: ${urls.length} URLs from ${sitemapUrl}`
                  );
                }
              } else if (
                content.includes("<?xml") ||
                content.includes("<rss") ||
                content.includes("<feed")
              ) {
                // Try parsing as RSS/Atom feed
                const urls = extractUrlsFromXml(content);
                urls.forEach((url) => {
                  try {
                    new URL(url);
                    discoveredUrls.add(url);
                  } catch {}
                });
                if (urls.length > 0) {
                  console.log(
                    `📄 Feed parsed: ${urls.length} URLs from ${sitemapUrl}`
                  );
                }
              } else if (!content.includes("<")) {
                // Might be a plain text sitemap
                const urls = parseTextSitemap(content);
                urls.forEach((url) => discoveredUrls.add(url));
                if (urls.length > 0) {
                  console.log(
                    `📄 Text sitemap parsed: ${urls.length} URLs from ${sitemapUrl}`
                  );
                }
              }

              resolve();
            } catch (parseError) {
              errors.push({
                url: sitemapUrl,
                error: `Parse error: ${parseError.message}`,
              });
              resolve();
            }
          });
        });

        req.on("error", (err) => {
          // Don't log errors for default sitemap locations that don't exist
          const isDefaultLocation =
            sitemapUrl.includes("sitemap_index") ||
            sitemapUrl.includes("sitemap-index") ||
            sitemapUrl.includes("sitemap1") ||
            sitemapUrl.includes("post-sitemap") ||
            sitemapUrl.includes("page-sitemap") ||
            sitemapUrl.includes("sitemaps.xml");
          if (!isDefaultLocation) {
            errors.push({ url: sitemapUrl, error: err.message });
          }
          resolve();
        });

        req.setTimeout(15000, () => {
          req.destroy();
          errors.push({ url: sitemapUrl, error: "Timeout (15s)" });
          resolve();
        });

        req.end();
      } catch (err) {
        errors.push({ url: sitemapUrl, error: err.message });
        resolve();
      }
    });
  }

  // Fetch all sitemaps
  console.log(
    `🔍 Checking ${sitemapUrls.length} potential sitemap location(s)...`
  );
  for (const sitemapUrl of sitemapUrls) {
    await fetchSingleSitemap(sitemapUrl, 0);
    // Stop early if we found enough URLs
    if (discoveredUrls.size > 5000) {
      console.log(
        `⚠️ Sitemap URL limit reached (5000+), stopping sitemap discovery`
      );
      break;
    }
  }

  const urlArray = Array.from(discoveredUrls);

  if (urlArray.length > 0) {
    console.log(
      `✅ Sitemap discovery complete: ${urlArray.length} total URLs found`
    );
  } else {
    console.log(`ℹ️ No sitemap found or no URLs discovered`);
  }

  return {
    urls: urlArray,
    errors: errors.filter((e) => !e.error.includes("ENOTFOUND")), // Filter out DNS errors for non-existent defaults
    found: urlArray.length > 0,
  };
}

/**
 * Interact with dropdown menus to reveal hidden links
 */
async function interactWithDropdowns(page) {
  try {
    const dropdownLinks = await safeEvaluate(
      page,
      () => {
        const links = [];

        // Find dropdown triggers (common patterns)
        const dropdownSelectors = [
          "button[aria-expanded]",
          'button[aria-haspopup="true"]',
          ".dropdown-toggle",
          ".dropdown-trigger",
          '[class*="dropdown"]',
          '[class*="menu-trigger"]',
          'nav a[href="#"]', // Links that might trigger dropdowns
        ];

        const triggers = [];
        dropdownSelectors.forEach((selector) => {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach((el) => triggers.push(el));
          } catch {}
        });

        // Try to click dropdowns and extract links
        triggers.forEach((trigger) => {
          try {
            // Check if it's a dropdown parent
            const parent = trigger.closest("li") || trigger.parentElement;
            if (parent) {
              const dropdownMenu = parent.querySelector(
                '.dropdown-menu, .dropdown, [role="menu"], ul'
              );
              if (dropdownMenu) {
                const menuLinks = dropdownMenu.querySelectorAll("a[href]");
                menuLinks.forEach((link) => {
                  const href = link.getAttribute("href");
                  if (href && href !== "#" && !href.startsWith("javascript:")) {
                    try {
                      // Resolve relative to current page (window.location.href)
                      let resolvedUrl;
                      if (
                        href.startsWith("http://") ||
                        href.startsWith("https://")
                      ) {
                        resolvedUrl = new URL(href);
                      } else if (href.startsWith("//")) {
                        resolvedUrl = new URL(
                          href,
                          window.location.protocol + "//" + window.location.host
                        );
                      } else if (href.startsWith("/")) {
                        resolvedUrl = new URL(href, window.location.origin);
                      } else {
                        // Relative URL - resolve relative to current page
                        resolvedUrl = new URL(href, window.location.href);
                      }
                      links.push(resolvedUrl.href);
                    } catch {
                      // Skip invalid URLs
                    }
                  }
                });
              }
            }
          } catch {}
        });

        return [...new Set(links)]; // Remove duplicates
      },
      []
    );

    // Also try clicking dropdowns to reveal content
    try {
      const dropdownButtons = await page.$$(
        'button[aria-expanded="false"], .dropdown-toggle:not(.active)'
      );
      for (const button of dropdownButtons.slice(0, 5)) {
        // Limit to 5 dropdowns
        try {
          await button.click({ timeout: 2000 });
          await page.waitForTimeout(500); // Wait for dropdown to open
        } catch {}
      }
    } catch {}

    return dropdownLinks;
  } catch (error) {
    console.warn("Error interacting with dropdowns:", error.message);
    return [];
  }
}

/**
 * Handle pagination and extract pagination links (without navigating)
 * Returns links from pagination controls to be crawled separately
 */
async function handlePagination(page, baseUrl) {
  const paginatedLinks = [];

  try {
    // Extract pagination links without navigating
    const paginationLinks = await safeEvaluate(
      page,
      () => {
        const links = [];

        // Find pagination container
        const paginationContainer = document.querySelector(
          '.pagination, [class*="pagination"], nav[aria-label*="pagination" i], [role="navigation"]'
        );

        if (paginationContainer) {
          // Extract all pagination links (numbered pages, next, previous)
          const paginationElements = paginationContainer.querySelectorAll(
            "a[href], button[data-page]"
          );

          paginationElements.forEach((el) => {
            try {
              let href = el.getAttribute("href");
              if (!href && el.hasAttribute("data-page")) {
                // Some pagination uses data attributes
                const pageNum = el.getAttribute("data-page");
                const currentUrl = new URL(window.location.href);
                // Try common pagination URL patterns
                if (currentUrl.searchParams.has("page")) {
                  currentUrl.searchParams.set("page", pageNum);
                  href = currentUrl.href;
                } else {
                  href = `${currentUrl.pathname}?page=${pageNum}`;
                }
              }

              if (href && href !== "#" && !href.startsWith("javascript:")) {
                try {
                  // Resolve relative to current page (window.location.href)
                  let resolvedUrl;
                  if (
                    href.startsWith("http://") ||
                    href.startsWith("https://")
                  ) {
                    resolvedUrl = new URL(href);
                  } else if (href.startsWith("//")) {
                    resolvedUrl = new URL(
                      href,
                      window.location.protocol + "//" + window.location.host
                    );
                  } else if (href.startsWith("/")) {
                    resolvedUrl = new URL(href, window.location.origin);
                  } else {
                    // Relative URL - resolve relative to current page
                    resolvedUrl = new URL(href, window.location.href);
                  }

                  // Only include pagination links (next, previous, numbered pages)
                  const text = el.textContent?.toLowerCase() || "";
                  const ariaLabel =
                    el.getAttribute("aria-label")?.toLowerCase() || "";
                  const isPaginationLink =
                    text.includes("next") ||
                    text.includes("previous") ||
                    text.includes("prev") ||
                    ariaLabel.includes("next") ||
                    ariaLabel.includes("previous") ||
                    ariaLabel.includes("page") ||
                    !isNaN(parseInt(text.trim()));

                  if (isPaginationLink) {
                    links.push(resolvedUrl.href);
                  }
                } catch {}
              }
            } catch {}
          });
        }

        // Also check for rel="next" links
        const nextLink = document.querySelector('link[rel="next"]');
        if (nextLink) {
          const href = nextLink.getAttribute("href");
          if (href) {
            try {
              // Resolve relative to current page (window.location.href)
              let resolvedUrl;
              if (href.startsWith("http://") || href.startsWith("https://")) {
                resolvedUrl = new URL(href);
              } else if (href.startsWith("//")) {
                resolvedUrl = new URL(
                  href,
                  window.location.protocol + "//" + window.location.host
                );
              } else if (href.startsWith("/")) {
                resolvedUrl = new URL(href, window.location.origin);
              } else {
                // Relative URL - resolve relative to current page
                resolvedUrl = new URL(href, window.location.href);
              }
              links.push(resolvedUrl.href);
            } catch {}
          }
        }

        return [...new Set(links)]; // Remove duplicates
      },
      []
    ).catch(() => []);

    paginatedLinks.push(...paginationLinks);

    return [...new Set(paginatedLinks)]; // Remove duplicates
  } catch (error) {
    console.warn("Error handling pagination:", error.message);
    return [];
  }
}

/**
 * Capture page fragments/sections (hash fragments that aren't routes)
 */
async function capturePageFragments(page, baseUrl) {
  const fragmentLinks = [];

  try {
    // Find all hash links that might be page sections
    const fragments = await safeEvaluate(
      page,
      () => {
        const fragmentLinks = [];
        const allLinks = document.querySelectorAll('a[href^="#"]');

        allLinks.forEach((link) => {
          const href = link.getAttribute("href");
          if (href && href !== "#" && !href.startsWith("#/")) {
            // This is a fragment (like #section-name), not a route
            const fragmentId = href.substring(1);
            const targetElement =
              document.getElementById(fragmentId) ||
              document.querySelector(`[name="${fragmentId}"]`) ||
              document.querySelector(`[id*="${fragmentId}"]`);

            if (targetElement) {
              // Check if this section has meaningful content
              const text = targetElement.textContent?.trim() || "";
              if (text.length > 50) {
                // Has meaningful content
                fragmentLinks.push({
                  fragment: href,
                  hasContent: true,
                  title: link.textContent?.trim() || fragmentId,
                });
              }
            }
          }
        });

        return fragmentLinks;
      },
      []
    );

    // Create full URLs for fragments
    fragments.forEach((fragment) => {
      try {
        const urlObj = new URL(baseUrl);
        urlObj.hash = fragment.fragment;
        fragmentLinks.push({
          url: urlObj.href,
          title: fragment.title,
          isFragment: true,
        });
      } catch {}
    });

    return fragmentLinks;
  } catch (error) {
    console.warn("Error capturing page fragments:", error.message);
    return [];
  }
}

/**
 * Wait for SPA content to load intelligently with timeout protection
 */
async function waitForSPAContent(page) {
  const MAX_WAIT_TIME = 10000; // Maximum 10 seconds total wait
  const startTime = Date.now();

  try {
    // Wait for DOM to be ready (with timeout and CSP-safe)
    try {
      await Promise.race([
        page.waitForFunction(() => document.readyState === "complete", {
          timeout: 3000,
        }),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch {
      // Continue if eval is disabled or timeout
    }

    // Check if page uses a common SPA framework
    const isSPA = await Promise.race([
      safeEvaluate(
        page,
        () => {
          return !!(
            window.React ||
            window.Vue ||
            window.angular ||
            window.__NEXT_DATA__ ||
            document.querySelector("[data-reactroot]") ||
            document.querySelector("[ng-app]") ||
            document.querySelector("[data-vue]")
          );
        },
        false
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]).catch(() => false);

    if (isSPA) {
      // Wait for network to be idle (with strict timeout)
      try {
        await Promise.race([
          page.waitForLoadState("networkidle", { timeout: SPA_WAIT_TIMEOUT }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("Network idle timeout")),
              SPA_WAIT_TIMEOUT
            )
          ),
        ]);
      } catch {
        // Fallback: wait for any dynamic content (with timeout)
        await Promise.race([
          page.waitForTimeout(2000),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    } else {
      // For non-SPA pages, shorter wait
      await Promise.race([
        page.waitForTimeout(500),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }

    // Check if we've exceeded max wait time
    if (Date.now() - startTime > MAX_WAIT_TIME) {
      return; // Stop waiting
    }

    // Wait for any pending mutations (simplified, with timeout)
    // Skip if eval is disabled (CSP)
    try {
      await Promise.race([
        safeEvaluate(
          page,
          () => {
            return new Promise((resolve) => {
              let timeout;
              let resolved = false;
              const observer = new MutationObserver(() => {
                if (!resolved) {
                  clearTimeout(timeout);
                  timeout = setTimeout(() => {
                    resolved = true;
                    observer.disconnect();
                    resolve();
                  }, 500);
                }
              });
              observer.observe(document.body, {
                childList: true,
                subtree: true,
              });
              timeout = setTimeout(() => {
                if (!resolved) {
                  resolved = true;
                  observer.disconnect();
                  resolve();
                }
              }, 1000);
            });
          },
          Promise.resolve()
        ),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Ignore errors
    }
  } catch (error) {
    // If all else fails, wait a bit (with timeout)
    await Promise.race([
      page.waitForTimeout(1000),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

/**
 * Safe evaluate wrapper that handles CSP/eval disabled errors
 */
async function safeEvaluate(page, fn, fallback = null) {
  try {
    return await page.evaluate(fn);
  } catch (error) {
    if (error.message && error.message.includes("eval is disabled")) {
      // CSP has disabled eval, return fallback or empty result
      console.warn(`⚠️ eval disabled on page, using fallback`);
      return fallback;
    }
    throw error;
  }
}

/**
 * Check if a URL is the root/homepage
 */
function isRootPage(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Root page has empty pathname or just "/", and no hash (or only #)
    return (
      (pathname === "/" || pathname === "") &&
      (!urlObj.hash || urlObj.hash === "" || urlObj.hash === "#")
    );
  } catch {
    return false;
  }
}

/**
 * Extract basic page data without using evaluate (for CSP-protected pages)
 * Uses Playwright's locator API instead of evaluate
 */
async function extractPageDataWithoutEval(page, url) {
  try {
    const links = [];

    // Extract title using locator (doesn't need eval)
    // For root page: use title tag instead of og:title
    // For other pages: Priority: og:title > h1 > title tag (to avoid generic site titles)
    let title = "Untitled";
    const isRoot = isRootPage(url);

    try {
      // For root page, skip og:title and use title tag directly
      if (!isRoot) {
        // Try og:title first (usually page-specific) - but not for root page
        const ogTitleElement = page
          .locator('meta[property="og:title"]')
          .first();
        if ((await ogTitleElement.count()) > 0) {
          const ogTitle = await ogTitleElement.getAttribute("content");
          if (ogTitle && ogTitle.trim()) {
            title = ogTitle.trim();
          }
        }
      }

      // If no og:title (or root page), try h1 (main page heading)
      if (title === "Untitled") {
        const h1Element = page.locator("h1").first();
        if ((await h1Element.count()) > 0) {
          const h1Text = await h1Element.textContent();
          if (h1Text && h1Text.trim() && h1Text.trim().length < 200) {
            title = h1Text.trim();
          }
        }
      }

      // For root page, prioritize title tag; for others, use as fallback
      if (title === "Untitled" || (isRoot && title === "Untitled")) {
        const titleElement = page.locator("title").first();
        if ((await titleElement.count()) > 0) {
          title = (await titleElement.textContent()) || "Untitled";
        }
      }

      // Final fallback: generate from URL
      if (title === "Untitled" || title.length < 3) {
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split("/").filter((p) => p);
          if (pathParts.length > 0) {
            title = pathParts[pathParts.length - 1]
              .replace(/-/g, " ")
              .replace(/_/g, " ")
              .replace(/\b\w/g, (l) => l.toUpperCase());
          } else {
            title = "Home";
          }
        } catch {
          title = "Page";
        }
      }
    } catch {}

    // Extract links using locator API (doesn't need eval)
    // Also extract link titles and original hrefs for better page titles
    const linkTitles = new Map();
    const originalHrefs = new Map();
    try {
      const linkElements = await page.locator("a[href]").all();
      for (const linkEl of linkElements) {
        try {
          const href = await linkEl.getAttribute("href");
          if (href && href !== "#" && !href.startsWith("javascript:")) {
            try {
              // Store original href before resolution
              const originalHref = href;

              // Resolve URL relative to current page URL (not base URL)
              // This ensures relative URLs resolve correctly
              let resolvedUrl;

              // Handle different URL types:
              // 1. Absolute URLs (http://, https://) - use as-is
              if (href.startsWith("http://") || href.startsWith("https://")) {
                resolvedUrl = new URL(href);
              }
              // 2. Protocol-relative URLs (//example.com) - use current protocol
              else if (href.startsWith("//")) {
                const urlObj = new URL(url);
                resolvedUrl = new URL(
                  href,
                  urlObj.protocol + "//" + urlObj.host
                );
              }
              // 3. Absolute paths (starting with /) - resolve relative to origin
              else if (href.startsWith("/")) {
                const urlObj = new URL(url);
                resolvedUrl = new URL(href, urlObj.origin);
              }
              // 4. Relative URLs (no leading /) - resolve relative to current page
              // This is the key fix: "about/index.php" on "/about" becomes "/about/about/index.php"
              else {
                resolvedUrl = new URL(href, url);
              }

              links.push(resolvedUrl.href);

              // Extract link text and title attribute
              try {
                const linkText = (await linkEl.textContent())?.trim() || "";
                const titleAttr =
                  (await linkEl.getAttribute("title"))?.trim() || "";
                const linkTitle = linkText || titleAttr;

                if (linkTitle) {
                  const normalized = resolvedUrl.href.replace(/\/$/, "");
                  linkTitles.set(resolvedUrl.href, linkTitle);
                  linkTitles.set(normalized, linkTitle);
                  linkTitles.set(normalized + "/", linkTitle);
                }

                // Store original href for this resolved URL
                const normalized = resolvedUrl.href.replace(/\/$/, "");
                originalHrefs.set(resolvedUrl.href, originalHref);
                originalHrefs.set(normalized, originalHref);
                originalHrefs.set(normalized + "/", originalHref);
              } catch {}
            } catch {
              // Skip invalid URLs
            }
          }
        } catch {}
      }
    } catch {}

    // Hash fragments are NOT extracted - they're just anchors on the same page
    // Only hash routes (#/route) are treated as separate pages
    const allLinks = [...new Set(links)];

    // Extract original hrefs map (we stored them in linkTitles above, need to separate)
    // Actually, we need to track original hrefs separately
    const originalHrefsForPage = new Map();
    // Note: We'll need to track this properly in the main extraction function
    // For now, this fallback function won't have original hrefs

    // Convert originalHrefs Map to plain object for serialization
    const originalHrefsObj = {};
    originalHrefs.forEach((originalHref, linkUrl) => {
      originalHrefsObj[linkUrl] = originalHref;
    });

    return {
      title: title.trim() || "Untitled",
      links: allLinks,
      pageData: {
        meta: {
          description: "",
          canonical: "",
        },
        links: allLinks,
        linkTitles: linkTitles,
        originalHrefs: originalHrefsObj,
      },
    };
  } catch (error) {
    console.warn(`Error extracting data without eval:`, error.message);
    return {
      title: "Untitled",
      links: [],
      pageData: { links: [] },
    };
  }
}

/**
 * Crawl a single page with retry logic and overall timeout protection
 */
async function crawlPage(
  context,
  url,
  retryCount = 0,
  linkTitleMap = null,
  checkRedirectDuplicates = false,
  originalHrefMap = null
) {
  const PAGE_CRAWL_TIMEOUT = 60000; // 60 seconds max per page

  // Wrap entire crawl in timeout
  return Promise.race([
    crawlPageInternal(
      context,
      url,
      retryCount,
      linkTitleMap,
      checkRedirectDuplicates,
      originalHrefMap
    ),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Page crawl timeout after ${PAGE_CRAWL_TIMEOUT}ms: ${url}`)
        );
      }, PAGE_CRAWL_TIMEOUT);
    }),
  ]).catch((error) => {
    if (error.message.includes("timeout")) {
      console.warn(`⚠️ Page crawl timeout: ${url}`);
      return {
        title: "Timeout",
        links: [],
        statusCode: 0,
        error: error.message,
      };
    }
    throw error;
  });
}

/**
 * Internal crawl page function
 */
async function crawlPageInternal(
  context,
  url,
  retryCount = 0,
  linkTitleMap = null,
  checkRedirectDuplicates = false,
  originalHrefMap = null
) {
  const page = await context.newPage();

  // Block unnecessary resources for faster crawling
  await page.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();

    // Block more resource types for better performance
    if (
      [
        "image",
        "font",
        "media",
        "stylesheet",
        "websocket",
        "manifest",
        "other",
      ].includes(resourceType)
    ) {
      route.abort();
    } else if (resourceType === "script") {
      // Allow scripts but block analytics/tracking
      if (
        url.includes("google-analytics") ||
        url.includes("googletagmanager") ||
        url.includes("facebook.net") ||
        url.includes("doubleclick") ||
        url.includes("analytics")
      ) {
        route.abort();
      } else {
        route.continue();
      }
    } else {
      route.continue();
    }
  });

  try {
    // Navigate with multiple strategies
    let navigationSuccess = false;
    let response = null;
    let statusCode = 200;
    const strategies = [
      { waitUntil: "domcontentloaded", timeout: PAGE_NAVIGATION_TIMEOUT },
      { waitUntil: "load", timeout: PAGE_NAVIGATION_TIMEOUT },
      { waitUntil: "networkidle", timeout: PAGE_NAVIGATION_TIMEOUT },
    ];

    let finalUrl = url; // Track final URL after redirects

    // If redirect duplicate checking is disabled, don't follow redirects at all
    // Playwright doesn't have maxRedirects option, so we'll handle redirects manually

    for (const strategy of strategies) {
      try {
        response = await page.goto(url, strategy);
        navigationSuccess = true;

        // Get status code
        if (response) {
          statusCode = response.status();

          // Check if a redirect occurred (Playwright automatically follows redirects)
          const responseUrl = response.url();
          const redirectOccurred = responseUrl && responseUrl !== url;

          // If redirect duplicate checking is disabled and a redirect occurred, ignore it
          // Use original URL instead of following redirects
          if (!checkRedirectDuplicates && redirectOccurred) {
            // Don't follow redirects - use original URL
            finalUrl = url;
            // Don't log redirects when toggle is off
          } else if (checkRedirectDuplicates && redirectOccurred) {
            // Only capture and log redirects if redirect duplicate checking is enabled
            finalUrl = responseUrl;
            // Check if redirect is to a different domain
            if (!sameDomain(url, finalUrl)) {
              // Check if it's still part of the same site (e.g., www.doordash.com -> about.doordash.com)
              if (sameSite(url, finalUrl)) {
                console.log(
                  `↪️ Cross-domain redirect (same site): ${url} -> ${finalUrl}`
                );
              } else {
                console.log(
                  `↪️ Cross-domain redirect (different site): ${url} -> ${finalUrl}`
                );
                // For different sites, we'll still crawl but note the redirect
              }
            } else {
              console.log(`↪️ Redirect: ${url} -> ${finalUrl}`);
            }
          }

          // Check for error status codes
          if (statusCode >= 400) {
            throw new Error(`HTTP ${statusCode}: ${response.statusText()}`);
          }
        }
        break;
      } catch (error) {
        if (strategy === strategies[strategies.length - 1]) {
          throw error;
        }
        // Try next strategy
      }
    }

    if (!navigationSuccess) {
      throw new Error("Navigation failed with all strategies");
    }

    // Get final URL from page (only if redirect duplicate checking is enabled)
    // When disabled, we always use the original URL (don't follow redirects)
    if (checkRedirectDuplicates) {
      try {
        const pageUrl = page.url();
        if (pageUrl && pageUrl !== url) {
          finalUrl = pageUrl;
          // Check if redirect is to a different domain
          if (!sameDomain(url, finalUrl)) {
            // Check if it's still part of the same site (e.g., www.doordash.com -> about.doordash.com)
            if (sameSite(url, finalUrl)) {
              console.log(
                `↪️ Cross-domain redirect (same site): ${url} -> ${finalUrl}`
              );
            } else {
              console.log(
                `↪️ Cross-domain redirect (different site): ${url} -> ${finalUrl}`
              );
              // For different sites, we'll still crawl but note the redirect
            }
          } else {
            console.log(`↪️ Redirect: ${url} -> ${finalUrl}`);
          }
        }
      } catch {
        // If we can't get page URL, use response URL or original URL
        // finalUrl is already set from response.url() above
      }
    }
    // When redirect duplicate checking is disabled, finalUrl is already set to url above

    // Check if this is a hash route (SPA route)
    const isHashRoute = finalUrl.includes("#/");

    // For hash routes, wait for the router to navigate first
    if (isHashRoute) {
      // Wait for hash route to load
      await page.waitForTimeout(2000);

      // Wait for the route content to appear (with CSP-safe check)
      try {
        // Use a timeout wrapper since waitForFunction uses eval internally
        await Promise.race([
          page.waitForFunction(
            () => {
              // Check if there's actual content (not just loading/blank)
              const body = document.body;
              if (!body) return false;
              const text = body.textContent || "";
              // Should have some meaningful content (more than just whitespace)
              return text.trim().length > 50;
            },
            { timeout: 10000 }
          ),
          new Promise((resolve) => setTimeout(resolve, 10000)),
        ]).catch(() => {
          // Continue even if timeout or eval disabled
        });
      } catch {
        // Continue
      }
    }

    // Check for bot protection pages (Cloudflare, etc.) - but be less aggressive for hash routes
    const isBlocked = await safeEvaluate(
      page,
      () => {
        const title = document.title.toLowerCase();
        const bodyText = document.body?.textContent?.toLowerCase() || "";
        const pageContent = document.documentElement.innerHTML.toLowerCase();

        // Only check for actual Cloudflare elements, not just title text (which might be from base page)
        const hasCloudflareElements =
          document.querySelector("#challenge-form") !== null ||
          document.querySelector(".cf-browser-verification") !== null ||
          document.querySelector("[data-ray]") !== null ||
          pageContent.includes("cf-browser-verification") ||
          pageContent.includes("ddos protection by cloudflare");

        // For title/body, only flag if it's the ONLY content (not just part of base page)
        const isOnlyBlockedContent =
          (title.includes("just a moment") ||
            title.includes("checking your browser")) &&
          bodyText.length < 100; // Very little content suggests it's actually blocked

        return hasCloudflareElements || isOnlyBlockedContent;
      },
      false
    );

    // If blocked, wait for challenge to resolve (but shorter wait for hash routes)
    if (isBlocked) {
      console.log(
        `⚠️ Bot protection detected for ${url}, waiting for challenge to resolve...`
      );

      // Shorter wait for hash routes (they might just be loading)
      const maxWaitTime = isHashRoute ? 5000 : 15000;
      const checkInterval = 500;
      const startTime = Date.now();
      let challengeResolved = false;

      while (Date.now() - startTime < maxWaitTime && !challengeResolved) {
        await page.waitForTimeout(checkInterval);

        challengeResolved = await safeEvaluate(
          page,
          () => {
            // Check if Cloudflare elements are gone
            const hasElements =
              document.querySelector("#challenge-form") !== null ||
              document.querySelector(".cf-browser-verification") !== null;

            if (hasElements) return false;

            // Check if there's actual content now
            const bodyText = document.body?.textContent || "";
            return bodyText.trim().length > 100;
          },
          false
        );
      }

      if (!challengeResolved && !isHashRoute) {
        console.warn(
          `⚠️ Challenge not resolved for ${url} after ${maxWaitTime}ms`
        );
      } else if (challengeResolved) {
        console.log(`✅ Challenge resolved for ${url}`);
        await page.waitForTimeout(1000);
      }
    }

    // Wait for SPA content intelligently
    await waitForSPAContent(page);

    // For hash routes, wait a bit more for route-specific content
    if (isHashRoute) {
      await page.waitForTimeout(2000);
    }

    // Interact with dropdown menus to reveal hidden links (with timeout)
    const dropdownLinks = await Promise.race([
      interactWithDropdowns(page),
      new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
    ]).catch(() => []);

    // Hash fragments are NOT captured - they're just anchors on the same page, not separate pages
    // Only hash routes (#/route) are treated as separate pages
    const fragmentLinks = [];

    // Handle pagination if present (with timeout)
    const paginatedLinks = await Promise.race([
      handlePagination(page, url),
      new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
    ]).catch(() => []);

    // Extract title with fallback
    // First, check if we have a link title for this URL (highest priority)
    let title = "Untitled";
    if (linkTitleMap) {
      const normalizedUrlForTitle = getCanonicalUrl(url);
      const linkTitle =
        linkTitleMap.get(url) ||
        linkTitleMap.get(normalizedUrlForTitle) ||
        linkTitleMap.get(normalizedUrlForTitle + "/") ||
        linkTitleMap.get(normalizedUrlForTitle.replace(/\/$/, ""));

      if (linkTitle && linkTitle.trim()) {
        title = linkTitle.trim();
      }
    }

    const blockedTitles = [
      "just a moment",
      "checking your browser",
      "please wait",
    ];

    // Only extract from page if we don't have a link title
    if (title === "Untitled") {
      try {
        // Check if this is the root page
        const isRoot = isRootPage(url);

        // For hash routes, try to get route-specific content first
        const pageInfo = await safeEvaluate(
          page,
          (isHashRoute, isRootPage) => {
            // Try multiple selectors for title - prioritize page-specific content over generic site title
            const titleEl = document.querySelector("title");
            const h1El = document.querySelector("h1");
            const h2El = document.querySelector("h2");
            const metaTitle = document.querySelector(
              'meta[property="og:title"]'
            );
            const metaTwitterTitle = document.querySelector(
              'meta[name="twitter:title"]'
            );

            // Get all possible title sources
            const titleTag = titleEl?.textContent?.trim() || "";
            const ogTitle = metaTitle?.getAttribute("content")?.trim() || "";
            const twitterTitle =
              metaTwitterTitle?.getAttribute("content")?.trim() || "";
            const h1Text = h1El?.textContent?.trim() || "";
            const h2Text = h2El?.textContent?.trim() || "";

            // For root page: use title tag instead of og:title
            // For other pages: prefer page-specific titles (og:title, h1) over generic <title> tag
            let titleText = "";

            if (isRootPage) {
              // Root page: prioritize title tag
              if (titleTag && titleTag.length > 0) {
                titleText = titleTag;
              }
              // Fallback to h1 for root page
              else if (h1Text && h1Text.length > 0 && h1Text.length < 200) {
                titleText = h1Text;
              }
              // Fallback to h2 for root page
              else if (h2Text && h2Text.length > 0 && h2Text.length < 200) {
                titleText = h2Text;
              }
            } else {
              // Non-root pages: First priority: og:title (usually page-specific)
              if (ogTitle && ogTitle.length > 0 && ogTitle.length < 200) {
                titleText = ogTitle;
              }
              // Second priority: twitter:title
              else if (
                twitterTitle &&
                twitterTitle.length > 0 &&
                twitterTitle.length < 200
              ) {
                titleText = twitterTitle;
              }
              // Third priority: h1 (usually the main page heading)
              else if (h1Text && h1Text.length > 0 && h1Text.length < 200) {
                titleText = h1Text;
              }
              // Fourth priority: <title> tag (may be generic)
              else if (titleTag && titleTag.length > 0) {
                titleText = titleTag;
              }
              // Fifth priority: h2
              else if (h2Text && h2Text.length > 0 && h2Text.length < 200) {
                titleText = h2Text;
              }
            }

            // For hash routes, also check for route-specific content
            if (isHashRoute && !titleText) {
              // Look for main content area
              const mainContent =
                document.querySelector("main") ||
                document.querySelector('[role="main"]') ||
                document.querySelector(".content") ||
                document.querySelector("#content") ||
                document.body;

              if (mainContent) {
                const h1 = mainContent.querySelector("h1");
                if (h1) titleText = h1.textContent?.trim() || "";
              }
            }

            return {
              title: titleText || "Untitled",
              hasContent:
                document.body && document.body.textContent.trim().length > 50,
              // Return all sources for debugging/fallback
              sources: { titleTag, ogTitle, twitterTitle, h1Text, h2Text },
            };
          },
          { title: "Untitled", hasContent: false, sources: {} },
          isHashRoute,
          isRoot
        );

        title = pageInfo.title;

        // If title looks like a generic site name (very short or doesn't contain URL keywords), try URL-based title
        if (title && title.length < 50) {
          try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split("/").filter((p) => p);
            if (pathParts.length > 0) {
              const lastPathPart = pathParts[pathParts.length - 1]
                .replace(/-/g, " ")
                .replace(/_/g, " ")
                .toLowerCase();

              // Check if the title doesn't seem related to the URL path
              // This catches cases where title is just "Company Name" for all pages
              const titleLower = title.toLowerCase();
              const pathKeywords = lastPathPart
                .split(" ")
                .filter((w) => w.length > 3);
              const hasPathKeyword = pathKeywords.some((kw) =>
                titleLower.includes(kw)
              );

              // If title doesn't contain any path keywords and h1 exists, prefer URL-based title
              if (
                !hasPathKeyword &&
                pathParts.length > 0 &&
                pageInfo.sources?.h1Text
              ) {
                // Keep h1 if it exists
              } else if (!hasPathKeyword && pathParts.length > 0) {
                // Use URL-based title as fallback
                const urlTitle = pathParts[pathParts.length - 1]
                  .replace(/-/g, " ")
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (l) => l.toUpperCase());
                if (urlTitle.length > 2) {
                  title = urlTitle;
                }
              }
            }
          } catch {}
        }

        // If title is still "Just a moment" or similar, use URL-based fallback immediately
        if (
          blockedTitles.some((blocked) => title.toLowerCase().includes(blocked))
        ) {
          // For hash routes, extract from hash path
          if (isHashRoute) {
            try {
              const urlObj = new URL(url);
              const hash = urlObj.hash?.substring(2); // Remove #/
              if (hash) {
                const hashParts = hash.split("/").filter((p) => p);
                if (hashParts.length > 0) {
                  const lastPart = hashParts[hashParts.length - 1];
                  title =
                    lastPart
                      .replace(/-/g, " ")
                      .replace(/_/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page";
                } else {
                  title = "Home";
                }
              } else {
                title = "Home";
              }
            } catch {
              title = "Page";
            }
          } else {
            // For non-hash routes, try waiting a bit more
            console.warn(
              `⚠️ Title still shows bot protection for ${url}, using URL-based title...`
            );
            try {
              const urlObj = new URL(url);
              const pathParts = urlObj.pathname.split("/").filter((p) => p);
              if (pathParts.length > 0) {
                title =
                  pathParts[pathParts.length - 1]
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page";
              } else {
                title = "Home";
              }
            } catch {
              title = "Page";
            }
          }
        }
      } catch (error) {
        // Fallback: use URL-based title
        try {
          if (isHashRoute) {
            const urlObj = new URL(url);
            const hash = urlObj.hash?.substring(2);
            if (hash) {
              const hashParts = hash.split("/").filter((p) => p);
              title =
                hashParts.length > 0
                  ? hashParts[hashParts.length - 1]
                      .replace(/-/g, " ")
                      .replace(/_/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase())
                  : "Home";
            } else {
              title = "Home";
            }
          } else {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split("/").filter((p) => p);
            title =
              pathParts.length > 0
                ? pathParts[pathParts.length - 1]
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (l) => l.toUpperCase())
                : "Home";
          }
        } catch {
          title = "Untitled";
        }
      }
    } // End of if (title === "Untitled")

    // Extract comprehensive page data (with CSP/eval fallback)
    let pageData;
    let links = [];
    // Note: title is already declared above

    try {
      pageData = await safeEvaluate(
        page,
        (isHashRoute) => {
          // Extract meta tags
          const metaDescription =
            document
              .querySelector('meta[name="description"]')
              ?.getAttribute("content") || "";
          const metaRobots =
            document
              .querySelector('meta[name="robots"]')
              ?.getAttribute("content") || "index,follow";
          const canonical =
            document
              .querySelector('link[rel="canonical"]')
              ?.getAttribute("href") || "";
          const ogTitle =
            document
              .querySelector('meta[property="og:title"]')
              ?.getAttribute("content") || "";

          // Extract content signals
          const h1 = document.querySelector("h1")?.textContent?.trim() || "";
          const h2Elements = document.querySelectorAll("h2");
          const h2Count = h2Elements.length;
          const bodyText = document.body?.textContent || "";
          const wordCount = bodyText
            .trim()
            .split(/\s+/)
            .filter((w) => w.length > 0).length;

          // Extract links with title information
          const allLinks = Array.from(document.querySelectorAll("a[href]"))
            .map((a) => {
              const href = a.getAttribute("href");
              if (!href) return null;

              // Extract link text (text content inside <a> tag)
              let linkText = "";
              // Get direct text content, excluding nested elements
              const textNodes = Array.from(a.childNodes)
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent.trim())
                .join(" ")
                .trim();

              // If no direct text, get all text content (including nested elements)
              if (!textNodes) {
                linkText = a.textContent?.trim() || "";
              } else {
                linkText = textNodes;
              }

              // Get title attribute
              const titleAttr = a.getAttribute("title")?.trim() || "";

              // Priority: link text > title attribute
              const linkTitle = linkText || titleAttr;

              try {
                // Resolve URL relative to current page (window.location.href)
                // This ensures relative URLs like "about/index.php" resolve correctly
                // when on a page like "https://example.com/about"
                const currentPageUrl = window.location.href;
                let resolvedUrl;

                // Handle different URL types:
                // 1. Absolute URLs (http://, https://) - use as-is
                if (href.startsWith("http://") || href.startsWith("https://")) {
                  resolvedUrl = new URL(href);
                }
                // 2. Protocol-relative URLs (//example.com) - use current protocol
                else if (href.startsWith("//")) {
                  resolvedUrl = new URL(
                    href,
                    window.location.protocol + "//" + window.location.host
                  );
                }
                // 3. Absolute paths (starting with /) - resolve relative to origin
                else if (href.startsWith("/")) {
                  resolvedUrl = new URL(href, window.location.origin);
                }
                // 4. Relative URLs (no leading /) - resolve relative to current page
                // This is the key fix: "about/index.php" on "/about" becomes "/about/about/index.php"
                else {
                  resolvedUrl = new URL(href, currentPageUrl);
                }

                return {
                  url: resolvedUrl.href,
                  title: linkTitle || null,
                  originalHref: href, // Store original href attribute as-is
                };
              } catch {
                // Fallback for hash links - only include hash routes (#/route), not fragments (#section)
                if (href.startsWith("#/")) {
                  // This is a hash route (SPA routing) - treat as separate page
                  const url =
                    window.location.origin + window.location.pathname + href;
                  return {
                    url: url,
                    title: linkTitle || null,
                    originalHref: href, // Store original href attribute as-is
                  };
                }
                // Skip hash fragments (#section) - they're just anchors on the same page
                // Last resort: try relative to origin (shouldn't normally happen)
                try {
                  const url = new URL(href, window.location.origin).href;
                  return {
                    url: url,
                    title: linkTitle || null,
                    originalHref: href, // Store original href attribute as-is
                  };
                } catch {
                  return null;
                }
              }
            })
            .filter(Boolean);

          // Combine all links - extract URLs and store titles in a map
          // Note: Hash fragments (#section) are NOT included - they're just anchors on the same page
          // Only hash routes (#/route) are treated as separate pages
          const linkUrls = [];
          const linkTitlesMap = new Map();
          // Note: This Map is in browser context (page.evaluate), separate from Node.js originalHrefMap
          const browserOriginalHrefMap = new Map();

          // Process regular links
          allLinks.forEach((linkObj) => {
            if (typeof linkObj === "string") {
              linkUrls.push(linkObj);
            } else if (linkObj && linkObj.url) {
              linkUrls.push(linkObj.url);
              if (linkObj.title) {
                // Normalize URL for title mapping (same as visited check)
                const normalized = linkObj.url.replace(/\/$/, "");
                linkTitlesMap.set(normalized, linkObj.title);
                linkTitlesMap.set(linkObj.url, linkObj.title); // Also store with trailing slash
                if (linkObj.url.endsWith("/")) {
                  linkTitlesMap.set(linkObj.url.slice(0, -1), linkObj.title);
                } else {
                  linkTitlesMap.set(linkObj.url + "/", linkObj.title);
                }
              }
              // Store original href for this resolved URL
              if (linkObj.originalHref) {
                const normalized = linkObj.url.replace(/\/$/, "");
                browserOriginalHrefMap.set(normalized, linkObj.originalHref);
                browserOriginalHrefMap.set(linkObj.url, linkObj.originalHref);
                if (linkObj.url.endsWith("/")) {
                  browserOriginalHrefMap.set(
                    linkObj.url.slice(0, -1),
                    linkObj.originalHref
                  );
                } else {
                  browserOriginalHrefMap.set(
                    linkObj.url + "/",
                    linkObj.originalHref
                  );
                }
              }
            }
          });

          const combinedLinks = [...new Set(linkUrls)];

          // Convert Map to plain object for serialization (Maps can't be serialized in evaluate)
          const linkTitlesObj = {};
          linkTitlesMap.forEach((title, url) => {
            linkTitlesObj[url] = title;
          });

          // Convert original hrefs Map to plain object (already populated above)
          const originalHrefObj = {};
          browserOriginalHrefMap.forEach((originalHref, url) => {
            originalHrefObj[url] = originalHref;
          });

          // Detect SPA framework
          const isSPA = !!(
            window.React ||
            window.Vue ||
            window.angular ||
            window.__NEXT_DATA__
          );
          const routeType = isHashRoute ? "hash" : isSPA ? "history" : "static";

          // Detect framework hints
          let frameworkHint = "unknown";
          if (window.__NEXT_DATA__) frameworkHint = "nextjs";
          else if (window.React) frameworkHint = "react";
          else if (window.Vue) frameworkHint = "vue";
          else if (window.angular) frameworkHint = "angular";

          // Classify page intent (simple heuristic)
          let intent = "informational";
          let pageType = "page";
          const path = window.location.pathname.toLowerCase();
          if (
            path.includes("/blog") ||
            path.includes("/article") ||
            path.includes("/post")
          ) {
            intent = "informational";
            pageType = "article";
          } else if (path.includes("/product") || path.includes("/shop")) {
            intent = "transactional";
            pageType = "product";
          } else if (
            path.includes("/learn") ||
            path.includes("/tutorial") ||
            path.includes("/guide")
          ) {
            intent = "informational";
            pageType = "article";
          }

          return {
            meta: {
              description: metaDescription,
              robots: metaRobots,
              canonical: canonical,
              ogTitle: ogTitle,
            },
            content_signals: {
              h1: h1,
              h2_count: h2Count,
              word_count: wordCount,
            },
            links: combinedLinks,
            linkTitles: linkTitlesObj,
            originalHrefs: originalHrefObj,
            tech: {
              is_spa: isSPA,
              route_type: routeType,
              framework_hint: frameworkHint,
            },
            classification: {
              intent: intent,
              page_type: pageType,
            },
          };
        },
        isHashRoute,
        null
      );

      // If eval is disabled, use fallback extraction method
      if (!pageData) {
        console.warn(
          `⚠️ Using fallback extraction for ${finalUrl} (eval disabled)`
        );
        const fallbackData = await extractPageDataWithoutEval(page, finalUrl);
        pageData = fallbackData.pageData || {
          links: [],
          linkTitles: new Map(),
        };
        title = fallbackData.title || title;
        links = fallbackData.links || [];
      } else {
        // Extract all links for backward compatibility
        // Combine regular links, dropdown links, and paginated links
        // Note: Fragment links are NOT included - hash fragments (#section) are just anchors on the same page
        const allExtractedLinks = [
          ...(pageData.links || []),
          ...dropdownLinks,
          ...paginatedLinks,
          // Fragment links removed - they're not separate pages
        ];
        // Sort links deterministically to ensure consistent discovery order
        links = [...new Set(allExtractedLinks)].sort((a, b) =>
          a.localeCompare(b)
        ); // Remove duplicates and sort

        // Store link titles in the global map
        if (pageData.linkTitles) {
          // Convert object back to Map entries
          if (pageData.linkTitles instanceof Map) {
            pageData.linkTitles.forEach((linkTitle, linkUrl) => {
              linkTitleMap.set(linkUrl, linkTitle);
            });
          } else if (typeof pageData.linkTitles === "object") {
            // It's a plain object from evaluate()
            Object.entries(pageData.linkTitles).forEach(
              ([linkUrl, linkTitle]) => {
                linkTitleMap.set(linkUrl, linkTitle);
              }
            );
          }
        }

        // Store original hrefs in the global map (if map is provided)
        if (originalHrefMap && pageData.originalHrefs) {
          // Convert object back to Map entries
          if (pageData.originalHrefs instanceof Map) {
            pageData.originalHrefs.forEach((originalHref, linkUrl) => {
              originalHrefMap.set(linkUrl, originalHref);
            });
          } else if (typeof pageData.originalHrefs === "object") {
            // It's a plain object from evaluate()
            Object.entries(pageData.originalHrefs).forEach(
              ([linkUrl, originalHref]) => {
                originalHrefMap.set(linkUrl, originalHref);
              }
            );
          }
        }
      }

      // Build normalized URL path from final URL (after redirects)
      let normalizedUrl = finalUrl;
      try {
        const urlObj = new URL(finalUrl);
        normalizedUrl = urlObj.pathname + (isHashRoute ? urlObj.hash : "");
        if (!normalizedUrl || normalizedUrl === "/") {
          normalizedUrl = "/";
        }
      } catch {
        normalizedUrl = finalUrl;
      }

      return {
        title,
        links,
        statusCode,
        finalUrl: finalUrl, // Include final URL after redirects
        originalUrl: url, // Include original URL for reference
        pageData: {
          ...pageData,
          normalized_url: normalizedUrl,
        },
      };
    } catch (error) {
      // Check if error is due to eval being disabled (CSP)
      const isEvalDisabled =
        error.message && error.message.includes("eval is disabled");

      if (isEvalDisabled) {
        // Don't retry - eval won't work on retry either
        console.warn(`⚠️ eval disabled on ${url}, using fallback extraction`);
        try {
          // Get final URL from page (may have redirected)
          const pageFinalUrl = page.url();
          const fallbackData = await extractPageDataWithoutEval(
            page,
            pageFinalUrl
          );
          await page.close();
          return {
            title: fallbackData.title,
            links: fallbackData.links,
            statusCode: 200,
            finalUrl: pageFinalUrl,
            originalUrl: url,
            pageData: fallbackData.pageData,
          };
        } catch (fallbackError) {
          await page.close();
          return {
            title: "Untitled",
            links: [],
            statusCode: 0,
            error: "eval disabled",
            finalUrl: url,
            originalUrl: url,
          };
        }
      }

      // Retry logic for other errors
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
        console.warn(
          `Retrying ${url} (attempt ${
            retryCount + 1
          }/${MAX_RETRIES}) after ${delay}ms:`,
          error.message
        );
        await page.close();
        await new Promise((resolve) => setTimeout(resolve, delay));
        return crawlPage(
          context,
          url,
          retryCount + 1,
          linkTitleMap,
          checkRedirectDuplicates,
          originalHrefMap
        );
      }

      console.warn(
        `Error crawling ${url} after ${MAX_RETRIES} attempts:`,
        error.message
      );
      await page.close();
      return {
        title: "Untitled",
        links: [],
        statusCode: 0,
        error: error.message,
        finalUrl: url,
        originalUrl: url,
      };
    }
  } finally {
    // Ensure page is closed
    try {
      if (page && !page.isClosed()) {
        await page.close();
      }
    } catch {}
  }
}

/**
 * Main crawl function - adapted from the provided Playwright crawler
 */
async function crawlWebsite({
  jobId,
  domain,
  maxDepth = 3,
  maxPages = 500,
  useSitemap = false,
  checkRedirectDuplicates = false, // Default: don't check redirect duplicates
  onProgress,
}) {
  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;

  const visited = new Set();
  const queue = [
    {
      url: baseUrl,
      depth: 0,
      parentUrl: null,
      linkTitle: null,
      originalHref: null,
    },
  ];
  const pages = [];
  // Pages per browser instance - configurable via PAGES_CONCURRENCY env var
  // Higher values = more parallel pages per browser (uses more memory per browser)
  // Lower values = fewer pages per browser (uses less memory, but may be slower)
  // Recommended for 8GB VM: 8-10 pages per browser with 3 browser instances = 24-30 total concurrent pages
  const CONCURRENCY = parseInt(process.env.PAGES_CONCURRENCY || "6");
  // Map to store link titles for discovered URLs
  const linkTitleMap = new Map();
  // Map to store original href attributes for discovered URLs
  const originalHrefMap = new Map();
  // Map to track error URLs (base URL -> error info)
  // Used to skip hash fragment URLs when base URL is already known to be broken
  const errorUrlMap = new Map(); // baseUrl -> { title: 'ERROR: ...', statusCode: 404 }
  // Track URLs currently being crawled to handle race conditions with anchor links
  const inFlightUrls = new Set(); // URLs currently being crawled

  // Error tracking for comprehensive reporting
  const crawlErrors = {
    pageErrors: [], // Errors while crawling individual pages
    sitemapErrors: [], // Errors from sitemap parsing
    criticalError: null, // Fatal error that stopped the crawl
    warnings: [], // Non-fatal warnings
    skippedFiles: [], // Files that were skipped (PDFs, etc.)
    stats: {
      totalAttempted: 0,
      successfulPages: 0,
      failedPages: 0,
      skippedPages: 0,
      skippedPdfs: 0,
      sitemapUrlsDiscovered: 0,
    },
  };

  console.log(`🚀 Starting crawl for ${baseUrl}`);
  console.log(`   Max depth: ${maxDepth}, Max pages: ${maxPages}`);

  // Load robots.txt for compliance
  const robots = await loadRobots(baseUrl);

  // Get crawl delay from robots.txt (default to our min delay if not specified)
  let crawlDelay = REQUEST_DELAY_MIN;
  if (robots && typeof robots.getCrawlDelay === "function") {
    const robotsDelay = robots.getCrawlDelay("*");
    if (robotsDelay && robotsDelay > 0) {
      // Convert seconds to milliseconds, respect minimum
      crawlDelay = Math.max(robotsDelay * 1000, REQUEST_DELAY_MIN);
      console.log(`🤖 Respecting robots.txt crawl-delay: ${crawlDelay}ms`);
    }
  }

  // Track sitemap-discovered URLs
  const sitemapPages = [];
  let sitemapResult = { found: false, urls: [], errors: [] };

  // Conditionally use sitemap.xml based on user preference
  if (useSitemap) {
    console.log(`📍 Checking for sitemap.xml...`);
    sitemapResult = await fetchSitemap(baseUrl, robots);

    if (sitemapResult.found) {
      crawlErrors.stats.sitemapUrlsDiscovered = sitemapResult.urls.length;

      // Filter to same domain only
      const sameDomainUrls = sitemapResult.urls.filter((url) => {
        try {
          return sameDomain(url, baseUrl);
        } catch {
          return false;
        }
      });

      console.log(
        `📄 Found ${sameDomainUrls.length} same-domain URLs from sitemap`
      );

      // SMART SITEMAP HANDLING:
      // - If sitemap has many URLs, store them directly without browser crawling
      // - Only browser-crawl a sample for content extraction
      // - Respect maxPages limit

      const SITEMAP_DIRECT_THRESHOLD = 100; // If more than this, store directly
      const BROWSER_CRAWL_SAMPLE = Math.min(50, maxPages); // How many to actually browser-crawl

      if (sameDomainUrls.length > SITEMAP_DIRECT_THRESHOLD) {
        console.log(
          `📊 Large sitemap detected (${sameDomainUrls.length} URLs). Storing URLs directly, browser-crawling sample of ${BROWSER_CRAWL_SAMPLE}`
        );

        // Limit total URLs to maxPages
        const urlsToStore = sameDomainUrls.slice(0, maxPages);

        // Store sitemap URLs directly (they're already discovered, no need to crawl)
        for (const sitemapUrl of urlsToStore) {
          const normalizedUrl = normalizeUrl(
            sitemapUrl,
            sitemapUrl.includes("#/")
          );
          if (normalizedUrl && !hasVisited(visited, normalizedUrl)) {
            markVisited(visited, normalizedUrl);

            // Generate title from URL
            let title = "Page";
            try {
              const urlObj = new URL(normalizedUrl);
              const pathParts = urlObj.pathname.split("/").filter((p) => p);
              if (pathParts.length > 0) {
                title = pathParts[pathParts.length - 1]
                  .replace(/-/g, " ")
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (l) => l.toUpperCase());
              } else {
                title = "Home";
              }
            } catch {}

            sitemapPages.push({
              url: normalizedUrl,
              depth: 1,
              parentUrl: baseUrl,
              title: title,
              fromSitemap: true,
            });
          }
        }

        console.log(
          `   ✅ Stored ${sitemapPages.length} URLs from sitemap directly`
        );

        // Add only a sample to the browser crawl queue for content extraction
        // Prioritize: homepage, then spread across different path prefixes
        const sampleUrls = selectSampleUrls(
          sameDomainUrls,
          BROWSER_CRAWL_SAMPLE
        );

        for (const sitemapUrl of sampleUrls) {
          const normalizedUrl = normalizeUrl(
            sitemapUrl,
            sitemapUrl.includes("#/")
          );
          if (normalizedUrl) {
            queue.push({
              url: normalizedUrl,
              depth: 1,
              parentUrl: baseUrl,
              fromSitemap: true,
              sampleCrawl: true, // Mark as sample crawl for content extraction
            });
          }
        }

        console.log(
          `   🔍 Added ${sampleUrls.length} URLs to browser crawl queue for content extraction`
        );
      } else {
        // Small sitemap - add all to crawl queue as before
        console.log(
          `📄 Adding ${sameDomainUrls.length} URLs from sitemap to crawl queue`
        );

        for (const sitemapUrl of sameDomainUrls) {
          const normalizedUrl = normalizeUrl(
            sitemapUrl,
            sitemapUrl.includes("#/")
          );
          if (normalizedUrl && !hasVisited(visited, normalizedUrl)) {
            queue.push({
              url: normalizedUrl,
              depth: 1,
              parentUrl: baseUrl,
              fromSitemap: true,
            });
          }
        }
      }
    }
  } else {
    console.log(`🔗 Using pure crawling (sitemap.xml discovery disabled)`);
  }

  // Record sitemap errors if any
  if (sitemapResult.errors && sitemapResult.errors.length > 0) {
    crawlErrors.sitemapErrors = sitemapResult.errors;
    crawlErrors.warnings.push(
      `Sitemap parsing had ${sitemapResult.errors.length} error(s)`
    );
  }

  // Store sitemap pages directly in database (before browser crawling)
  if (sitemapPages.length > 0) {
    console.log(
      `💾 Storing ${sitemapPages.length} sitemap URLs in database...`
    );
    let storedCount = 0;
    // Check if job still exists before storing sitemap pages
    const jobStillExists = await jobExists(jobId);
    if (!jobStillExists) {
      console.log(`⚠️ Job ${jobId} was deleted, skipping sitemap page storage`);
    } else {
      for (const page of sitemapPages) {
        try {
          // Double-check job exists before each insert
          if (!(await jobExists(jobId))) {
            console.log(
              `⚠️ Job ${jobId} was deleted during sitemap storage, stopping`
            );
            break;
          }
          const pageResult = await queryWithRetry(
            "INSERT INTO pages (job_id, url, depth, parent_url, title, status_code, original_href) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (job_id, url) DO NOTHING RETURNING id",
            [jobId, page.url, page.depth, page.parentUrl, page.title, 200, null]
          );
          if (pageResult.rows.length > 0) {
            pages.push({
              id: pageResult.rows[0].id,
              url: page.url,
              depth: page.depth,
              parentUrl: page.parentUrl,
              title: page.title,
              fromSitemap: true,
            });
            storedCount++;
          }
        } catch (dbError) {
          // Ignore duplicate errors and foreign key violations (job might have been deleted)
          if (
            !dbError.message.includes("duplicate") &&
            !dbError.message.includes("foreign key constraint")
          ) {
            console.warn(
              `   ⚠️ Error storing sitemap page: ${dbError.message}`
            );
          }
        }
      }
    }
    console.log(`   ✅ Stored ${storedCount} new pages from sitemap`);
    crawlErrors.stats.successfulPages += storedCount;

    // Report progress
    if (onProgress) {
      await onProgress({ pagesCrawled: pages.length });
    }
  }

  // Launch browser with stealth settings
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    });
  } catch (browserError) {
    crawlErrors.criticalError = `Failed to launch browser: ${browserError.message}`;
    console.error(`❌ ${crawlErrors.criticalError}`);
    throw new Error(crawlErrors.criticalError);
  }

  // Create context with realistic browser fingerprint
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: [],
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      DNT: "1",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  // Add stealth scripts to avoid detection
  await context.addInitScript(() => {
    // Override webdriver property
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });

    // Override plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // Override languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    // Override chrome
    window.chrome = {
      runtime: {},
    };

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  // Track why crawl stopped (declared outside try block so it's accessible in finally)
  let stopReason = null;

  try {
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 1000; // Stop if too many consecutive failures
    let lastProgressTime = Date.now();
    const PROGRESS_TIMEOUT = 300000; // 5 minutes without progress

    while (queue.length > 0 && visited.size < maxPages) {
      // Check for timeout without progress
      if (Date.now() - lastProgressTime > PROGRESS_TIMEOUT) {
        stopReason = `Crawl timeout: No progress for ${
          PROGRESS_TIMEOUT / 1000
        } seconds`;
        crawlErrors.warnings.push(stopReason);
        console.warn(`⚠️ ${stopReason}`);
        break;
      }

      // Check for too many consecutive failures
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `Too many consecutive failures (${consecutiveFailures})`;
        crawlErrors.criticalError = stopReason;
        console.warn(`⚠️ ${stopReason}, stopping crawl`);
        break;
      }

      // Sort queue to preserve navigation structure
      // Priority: 1) Depth 2) Links with titles (navigation - preserve order) 3) Links without titles (sort by URL)
      queue.sort((a, b) => {
        // Sort by depth first (BFS)
        if (a.depth !== b.depth) return a.depth - b.depth;

        // Within same depth, prioritize links with titles (navigation links)
        const hasTitleA = !!a.linkTitle;
        const hasTitleB = !!b.linkTitle;

        if (hasTitleA && !hasTitleB) return -1; // A has title, B doesn't - A comes first
        if (!hasTitleA && hasTitleB) return 1; // B has title, A doesn't - B comes first

        // Both have titles - preserve original order (don't sort by title)
        // Use a stable sort key based on original insertion order
        // Since we can't track original order easily in queue, use URL as tiebreaker
        // but this maintains relative order for items added in same batch
        if (hasTitleA && hasTitleB) {
          // Don't sort by title - preserve order by using URL as stable sort key
          // This maintains the order links were discovered/added
          return a.url.localeCompare(b.url);
        }

        // Both don't have titles - sort alphabetically by URL for deterministic order
        return a.url.localeCompare(b.url);
      });

      const batch = queue.splice(0, CONCURRENCY);

      // Use Promise.allSettled to prevent one hanging page from blocking others
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            // For hash routes, preserve hash; otherwise normalize
            const hasHashRoute = item.url.includes("#/");
            const url = normalizeUrl(item.url, hasHashRoute);

            // Check if we have a link title for this URL
            const itemLinkTitle = item.linkTitle || null;
            if (itemLinkTitle) {
              const normalizedForTitle = getCanonicalUrl(url);
              linkTitleMap.set(url, itemLinkTitle);
              linkTitleMap.set(normalizedForTitle, itemLinkTitle);
              linkTitleMap.set(normalizedForTitle + "/", itemLinkTitle);
              if (
                normalizedForTitle !== normalizedForTitle.replace(/\/$/, "")
              ) {
                linkTitleMap.set(
                  normalizedForTitle.replace(/\/$/, ""),
                  itemLinkTitle
                );
              }
            }

            // Check if we have an original href for this URL
            const itemOriginalHref = item.originalHref || null;
            if (itemOriginalHref) {
              const normalizedForHref = getCanonicalUrl(url);
              originalHrefMap.set(url, itemOriginalHref);
              originalHrefMap.set(normalizedForHref, itemOriginalHref);
              originalHrefMap.set(normalizedForHref + "/", itemOriginalHref);
              if (normalizedForHref !== normalizedForHref.replace(/\/$/, "")) {
                originalHrefMap.set(
                  normalizedForHref.replace(/\/$/, ""),
                  itemOriginalHref
                );
              }
            }

            // Skip if already visited, invalid, or exceeds depth
            if (!url || hasVisited(visited, url) || item.depth > maxDepth) {
              return { success: true, skipped: true };
            }

            // Validate URL format
            try {
              new URL(url);
            } catch {
              console.warn(`Invalid URL skipped: ${url}`);
              return { success: true, skipped: true };
            }

            // Normalize hash fragments to base URL (hash fragments are just anchors on the same page)
            // Only hash routes (#/route) are treated as separate pages
            const baseUrl = getBaseUrl(url);
            if (baseUrl !== url) {
              // This URL has a hash fragment (and it's not a #/ route)
              // Hash fragments are the same page as the base URL, so skip if base URL already visited
              if (hasVisited(visited, baseUrl)) {
                // Base URL already crawled - hash fragment is the same page, skip it
                markVisited(visited, url); // Mark fragment as visited too
                return {
                  success: true,
                  skipped: true,
                  reason: "hash_fragment_same_page",
                };
              }
              // Base URL not visited yet - normalize to base URL and continue
              // (This handles edge cases where hash fragment URLs get into queue from sitemaps, etc.)
              url = baseUrl;
            }

            // Check robots.txt compliance
            if (robots && !robots.isAllowed(url, "*")) {
              console.log(`🚫 Blocked by robots.txt: ${url}`);
              return { success: true, skipped: true };
            }

            // Mark URL as in-flight before crawling
            inFlightUrls.add(url);

            markVisited(visited, url);
            console.log(`✔ [${item.depth}] ${url}`);

            // Add delay between requests - respect robots.txt crawl-delay or use deterministic delay
            // This ensures polite crawling and the same URL always gets the same delay
            const urlHash = url
              .split("")
              .reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const baseDelay = Math.max(crawlDelay, REQUEST_DELAY_MIN);
            const delay =
              baseDelay + (urlHash % (REQUEST_DELAY_MAX - baseDelay + 1));
            await new Promise((resolve) => setTimeout(resolve, delay));

            // Crawl the page (with timeout protection)
            crawlErrors.stats.totalAttempted++;
            const {
              title,
              links,
              statusCode = 200,
              error,
              pageData,
              finalUrl,
              originalUrl,
            } = await crawlPage(
              context,
              url,
              0,
              linkTitleMap,
              checkRedirectDuplicates,
              originalHrefMap
            );

            // Use final URL after redirects ONLY if redirect duplicate checking is enabled
            // Otherwise, ignore redirects and use original URL (default behavior)
            const actualUrl = checkRedirectDuplicates ? finalUrl || url : url;

            // If redirect duplicate checking is enabled, check if redirect led to an already-visited URL
            if (
              checkRedirectDuplicates &&
              finalUrl &&
              finalUrl !== url &&
              hasVisited(visited, finalUrl)
            ) {
              console.log(
                `ℹ️  Redirect to already-visited URL: ${url} -> ${finalUrl}`
              );
              return { success: true, skipped: true };
            }

            // Mark final URL as visited to prevent duplicate crawls (only if redirect duplicate checking is enabled)
            if (checkRedirectDuplicates && finalUrl && finalUrl !== url) {
              markVisited(visited, finalUrl);
            }

            // Track page-level errors
            if (error) {
              crawlErrors.stats.failedPages++;
              crawlErrors.pageErrors.push({
                url: url,
                error: error,
                statusCode: statusCode,
                depth: item.depth,
                timestamp: new Date().toISOString(),
              });

              // Store error in errorUrlMap for base URL (without hash fragment)
              // This allows us to skip hash fragment URLs when base URL is already known to be broken
              const baseUrlForError = getBaseUrl(url);
              if (baseUrlForError && !errorUrlMap.has(baseUrlForError)) {
                errorUrlMap.set(baseUrlForError, {
                  title: `ERROR: ${error}`,
                  statusCode: statusCode || 0,
                });
              }
            } else {
              crawlErrors.stats.successfulPages++;
            }

            // Clean up title
            let cleanedTitle = title;
            if (
              !cleanedTitle ||
              cleanedTitle === "ERROR: Error" ||
              cleanedTitle === "Error" ||
              cleanedTitle === "ERROR"
            ) {
              try {
                const urlObj = new URL(url);
                const hash = urlObj.hash?.substring(1);
                const pathParts = urlObj.pathname.split("/").filter((p) => p);
                if (hash && hash.startsWith("/")) {
                  cleanedTitle =
                    hash
                      .substring(1)
                      .split("/")
                      .pop()
                      ?.replace(/-/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page";
                } else if (hash) {
                  cleanedTitle =
                    hash
                      .replace(/-/g, " ")
                      .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page";
                } else {
                  cleanedTitle =
                    pathParts.length > 0
                      ? pathParts[pathParts.length - 1]
                          .replace(/-/g, " ")
                          .replace(/\b\w/g, (l) => l.toUpperCase())
                      : "Home";
                }
              } catch {
                cleanedTitle = "Page";
              }
            }

            // Store page in database
            // Use final URL after redirects ONLY if redirect duplicate checking is enabled
            // Otherwise, use original URL (ignore redirects)
            try {
              // Check if job still exists before inserting (might have been deleted)
              const jobStillExists = await jobExists(jobId);
              if (!jobStillExists) {
                console.log(
                  `⚠️ Job ${jobId} was deleted, skipping page insertion for ${url}`
                );
                return { success: true, skipped: true, reason: "job_deleted" };
              }

              const finalStatusCode = error ? statusCode || 0 : statusCode;
              const finalTitle = error ? `ERROR: ${error}` : cleanedTitle;
              const urlToStore = checkRedirectDuplicates ? actualUrl : url;

              // Get original href for this page if available (before inserting)
              const pageOriginalHref =
                item.originalHref ||
                originalHrefMap.get(urlToStore) ||
                originalHrefMap.get(getCanonicalUrl(urlToStore)) ||
                originalHrefMap.get(getCanonicalUrl(urlToStore) + "/") ||
                null;

              // Use ON CONFLICT to handle cases where redirect leads to already-crawled URL
              const pageResult = await queryWithRetry(
                "INSERT INTO pages (job_id, url, depth, parent_url, title, status_code, original_href) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (job_id, url) DO NOTHING RETURNING id",
                [
                  jobId,
                  urlToStore, // Store final URL if redirect checking enabled, otherwise original URL
                  item.depth,
                  item.parentUrl,
                  finalTitle,
                  finalStatusCode,
                  pageOriginalHref,
                ]
              );

              // Only add to pages array if insert was successful (not a duplicate)
              if (pageResult.rows.length > 0) {
                // Store original href in pageData if available
                const enhancedPageData = pageData
                  ? {
                      ...pageData,
                      originalHref: pageOriginalHref,
                    }
                  : pageOriginalHref
                  ? { originalHref: pageOriginalHref }
                  : null;

                pages.push({
                  id: pageResult.rows[0].id,
                  url: urlToStore,
                  depth: item.depth,
                  parentUrl: item.parentUrl,
                  title: cleanedTitle,
                  pageData: enhancedPageData, // Store enhanced page data with original href
                  originalUrl: checkRedirectDuplicates
                    ? originalUrl || url
                    : undefined, // Only track original if redirect checking enabled
                });
              } else {
                // URL already exists (likely from a redirect or direct crawl)
                // Only log and mark as visited if redirect duplicate checking is enabled
                if (checkRedirectDuplicates) {
                  markVisited(visited, urlToStore);
                  console.log(
                    `ℹ️  URL already exists (redirect duplicate): ${urlToStore}`
                  );
                }
                // When toggle is off, silently skip duplicates (they're just regular DB duplicates)
              }
            } catch (dbError) {
              // Only log if it's not a duplicate key error (which we now handle with ON CONFLICT)
              if (!dbError.message.includes("duplicate key")) {
                console.error(
                  `Error storing page ${urlToStore} in DB:`,
                  dbError.message
                );
              }
            }

            // Process links (only if page was successfully crawled)
            // Use final URL for same-site checking ONLY if redirect duplicate checking is enabled
            // Otherwise, use original URL (ignore redirects)
            const urlForLinkChecking = checkRedirectDuplicates
              ? actualUrl
              : url;

            if (!error && links && links.length > 0) {
              // Preserve navigation order: links with titles keep their original HTML order
              // Priority: 1) Links with titles (navigation - preserve order) 2) Links without titles (footer/content - can sort)
              const getTitle = (url) => {
                return (
                  linkTitleMap.get(url) ||
                  linkTitleMap.get(normalizeUrl(url)) ||
                  linkTitleMap.get(getCanonicalUrl(url)) ||
                  linkTitleMap.get(getCanonicalUrl(url) + "/") ||
                  null
                );
              };

              // Separate links into navigation (with titles) and footer/content (without titles)
              const navigationLinks = [];
              const otherLinks = [];

              links.forEach((link) => {
                if (getTitle(link)) {
                  navigationLinks.push(link); // Keep original order
                } else {
                  otherLinks.push(link);
                }
              });

              // Sort only the links without titles (footer/content links)
              otherLinks.sort((a, b) => a.localeCompare(b));

              // Combine: navigation links first (in original order), then sorted footer/content links
              const sortedLinks = [...navigationLinks, ...otherLinks];

              for (const link of sortedLinks) {
                try {
                  // Validate link URL
                  const linkUrl = new URL(link);

                  // Skip PDF files and other non-HTML content
                  const pathname = linkUrl.pathname.toLowerCase();
                  if (
                    pathname.endsWith(".pdf") ||
                    pathname.endsWith(".doc") ||
                    pathname.endsWith(".docx") ||
                    pathname.endsWith(".xls") ||
                    pathname.endsWith(".xlsx") ||
                    pathname.endsWith(".ppt") ||
                    pathname.endsWith(".pptx") ||
                    pathname.endsWith(".zip") ||
                    pathname.endsWith(".rar") ||
                    pathname.endsWith(".exe") ||
                    pathname.endsWith(".dmg") ||
                    pathname.endsWith(".jpg") ||
                    pathname.endsWith(".jpeg") ||
                    pathname.endsWith(".png") ||
                    pathname.endsWith(".gif") ||
                    pathname.endsWith(".svg") ||
                    pathname.endsWith(".mp3") ||
                    pathname.endsWith(".mp4") ||
                    pathname.endsWith(".avi") ||
                    pathname.endsWith(".mov")
                  ) {
                    // Track skipped PDFs specifically
                    if (pathname.endsWith(".pdf")) {
                      crawlErrors.stats.skippedPdfs++;
                      crawlErrors.skippedFiles.push({
                        url: link,
                        type: "pdf",
                        foundOn: actualUrl,
                      });
                    }
                    continue; // Skip non-HTML files
                  }

                  // Check if this is a hash route (#/) - hash fragments (#section) are skipped
                  const isHashRoute = link.includes("#/");
                  // Hash fragments (like #section) are just anchors on the same page - skip them
                  const isHashFragment =
                    link.includes("#") &&
                    !link.includes("#/") &&
                    link.split("#")[1]?.length > 0;

                  // Skip hash fragments - they're the same page as the base URL
                  if (isHashFragment) {
                    continue;
                  }

                  // Only preserve hash for hash routes (#/route) - these are separate pages
                  const preserveHash = isHashRoute;
                  const normalizedLink = normalizeUrl(link, preserveHash);

                  // Use sameSite check instead of sameDomain to handle subdomain redirects
                  // e.g., www.doordash.com -> about.doordash.com
                  if (
                    normalizedLink &&
                    !hasVisited(visited, normalizedLink) &&
                    sameSite(normalizedLink, baseUrl) && // Changed from sameDomain to sameSite
                    item.depth < maxDepth &&
                    linkUrl.protocol.startsWith("http") // Only HTTP/HTTPS
                  ) {
                    // Get link title from the linkTitleMap if available
                    const linkTitle =
                      linkTitleMap.get(link) ||
                      linkTitleMap.get(normalizedLink) ||
                      linkTitleMap.get(getCanonicalUrl(normalizedLink)) ||
                      linkTitleMap.get(getCanonicalUrl(normalizedLink) + "/");

                    // Get original href from the originalHrefMap if available
                    const originalHref =
                      originalHrefMap.get(link) ||
                      originalHrefMap.get(normalizedLink) ||
                      originalHrefMap.get(getCanonicalUrl(normalizedLink)) ||
                      originalHrefMap.get(
                        getCanonicalUrl(normalizedLink) + "/"
                      );

                    queue.push({
                      url: normalizedLink,
                      depth: item.depth + 1,
                      parentUrl: checkRedirectDuplicates ? actualUrl : url, // Use actual URL after redirects only if redirect checking enabled
                      linkTitle: linkTitle || null,
                      originalHref: originalHref || null,
                    });
                  }
                } catch (linkError) {
                  // Skip invalid links
                  continue;
                }
              }
            }

            // Report progress
            if (onProgress) {
              await onProgress({ pagesCrawled: pages.length });
            }

            // Remove from in-flight tracking
            inFlightUrls.delete(url);
            if (checkRedirectDuplicates && finalUrl && finalUrl !== url) {
              inFlightUrls.delete(finalUrl);
            }

            return { success: true };
          } catch (error) {
            // Handle errors within the async function
            crawlErrors.stats.totalAttempted++;
            crawlErrors.stats.failedPages++;

            const errorInfo = {
              url: item.url,
              error: error.message,
              statusCode: 0,
              depth: item.depth,
              timestamp: new Date().toISOString(),
            };
            crawlErrors.pageErrors.push(errorInfo);

            console.warn(`⚠️ Error crawling ${item.url}:`, error.message);
            try {
              // Check if job still exists before inserting error page
              const jobStillExists = await jobExists(jobId);
              if (jobStillExists) {
                // Get original href for error page if available
                const errorOriginalHref = item.originalHref || null;
                await queryWithRetry(
                  "INSERT INTO pages (job_id, url, depth, parent_url, title, status_code, original_href) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (job_id, url) DO NOTHING",
                  [
                    jobId,
                    item.url,
                    item.depth,
                    item.parentUrl,
                    `ERROR: ${error.message}`,
                    0,
                    errorOriginalHref,
                  ]
                );
              }
            } catch (dbError) {
              // Ignore database errors (including duplicates and foreign key violations)
              if (!dbError.message.includes("foreign key constraint")) {
                console.warn(
                  `Database error storing failed page:`,
                  dbError.message
                );
              }
            }

            // Remove from in-flight tracking (even on error)
            inFlightUrls.delete(item.url);
            const baseUrlForError = getBaseUrl(item.url);
            if (baseUrlForError && baseUrlForError !== item.url) {
              // Also track error for base URL to help with anchor link detection
              if (!errorUrlMap.has(baseUrlForError)) {
                errorUrlMap.set(baseUrlForError, {
                  title: `ERROR: ${error.message}`,
                  statusCode: 0,
                });
              }
            }

            return { success: false, error: error.message, url: item.url };
          }
        })
      );

      // Process results - handle both fulfilled and rejected promises
      let batchSuccessCount = 0;
      results.forEach((result) => {
        if (result.status === "rejected") {
          consecutiveFailures++;
          const errorMsg = result.reason?.message || "Unknown error";
          crawlErrors.pageErrors.push({
            url: "unknown",
            error: `Promise rejected: ${errorMsg}`,
            statusCode: 0,
            depth: -1,
            timestamp: new Date().toISOString(),
          });
          console.warn(`⚠️ Promise rejected:`, errorMsg);
        } else if (result.value) {
          if (result.value.success && !result.value.skipped) {
            consecutiveFailures = 0; // Reset on success
            batchSuccessCount++;
            lastProgressTime = Date.now(); // Update progress time
          } else if (result.value.skipped) {
            crawlErrors.stats.skippedPages++;
          } else if (!result.value.success) {
            consecutiveFailures++;
          }
        }
      });
    }

    // Set stop reason if we completed normally
    if (!stopReason) {
      if (visited.size >= maxPages) {
        stopReason = `Reached max pages limit (${maxPages})`;
      } else if (queue.length === 0) {
        stopReason = "All discoverable pages crawled";
      }
    }
  } catch (crawlError) {
    crawlErrors.criticalError = `Crawl failed: ${crawlError.message}`;
    console.error(`❌ ${crawlErrors.criticalError}`);
    throw crawlError;
  } finally {
    await browser.close();
  }

  // Log final statistics
  console.log(`\n📊 Crawl Complete for ${baseUrl}`);
  console.log(`   Pages crawled: ${pages.length}`);
  console.log(`   Successful: ${crawlErrors.stats.successfulPages}`);
  console.log(`   Failed: ${crawlErrors.stats.failedPages}`);
  console.log(`   Skipped: ${crawlErrors.stats.skippedPages}`);
  if (crawlErrors.stats.skippedPdfs > 0) {
    console.log(`   📄 PDFs ignored: ${crawlErrors.stats.skippedPdfs}`);
  }
  if (crawlErrors.stats.sitemapUrlsDiscovered > 0) {
    console.log(
      `   URLs from sitemap: ${crawlErrors.stats.sitemapUrlsDiscovered}`
    );
  }
  if (crawlErrors.pageErrors.length > 0) {
    console.log(
      `   ⚠️ ${crawlErrors.pageErrors.length} page error(s) occurred`
    );
  }

  // Return pages with error summary attached
  // The error info can be accessed via pages._crawlErrors
  const result = pages;
  result._crawlErrors = crawlErrors;
  result._crawlStats = {
    totalPages: pages.length,
    ...crawlErrors.stats,
    sitemapUsed: crawlErrors.stats.sitemapUrlsDiscovered > 0,
    stopReason: stopReason,
  };

  return result;
}

module.exports = { crawlWebsite, fetchSitemap };
