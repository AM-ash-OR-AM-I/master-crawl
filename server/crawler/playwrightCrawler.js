const { chromium } = require('playwright');
const robotsParser = require('robots-parser');
const { URL } = require('url');
const { pool } = require('../db/init');

let browserInstance = null;

// Configuration constants
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // Base delay in ms
const REQUEST_DELAY_MIN = 500; // Minimum delay between requests
const REQUEST_DELAY_MAX = 2000; // Maximum delay between requests
const SPA_WAIT_TIMEOUT = 5000; // Max wait for SPA content
const PAGE_NAVIGATION_TIMEOUT = 30000; // Increased timeout

/**
 * Normalize URL - preserve hash for SPAs, remove query params, trailing slash
 */
function normalizeUrl(url, preserveHash = false) {
  try {
    const u = new URL(url);
    // For SPAs, preserve hash routes (hash starting with #/)
    if (!preserveHash || !u.hash || !u.hash.startsWith('#/')) {
      u.hash = '';
    }
    u.search = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return null;
  }
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
 * Load robots.txt
 */
async function loadRobots(url) {
  try {
    const https = require('https');
    const http = require('http');
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    
    return new Promise((resolve) => {
      const client = u.protocol === 'https:' ? https : http;
      const req = client.get(robotsUrl, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const robots = robotsParser(robotsUrl, data);
            console.log('🤖 robots.txt loaded');
            resolve(robots);
          } catch {
            resolve({ isAllowed: () => true });
          }
        });
      });
      req.on('error', () => {
        console.log('⚠️ robots.txt not found, crawling allowed');
        resolve({ isAllowed: () => true });
      });
      req.setTimeout(5000, () => {
        req.destroy();
        console.log('⚠️ robots.txt timeout, crawling allowed');
        resolve({ isAllowed: () => true });
      });
    });
  } catch {
    console.log('⚠️ robots.txt not found, crawling allowed');
    return { isAllowed: () => true };
  }
}

/**
 * Wait for SPA content to load intelligently
 */
async function waitForSPAContent(page) {
  try {
    // Wait for DOM to be ready
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 3000 }
    ).catch(() => {});

    // Check if page uses a common SPA framework
    const isSPA = await page.evaluate(() => {
      // Check for React, Vue, Angular, or other SPA indicators
      return !!(
        window.React ||
        window.Vue ||
        window.angular ||
        window.__NEXT_DATA__ ||
        document.querySelector('[data-reactroot]') ||
        document.querySelector('[ng-app]') ||
        document.querySelector('[data-vue]')
      );
    });

    if (isSPA) {
      // Wait for network to be idle (indicates content loaded)
      try {
        await page.waitForLoadState('networkidle', { timeout: SPA_WAIT_TIMEOUT });
      } catch {
        // Fallback: wait for any dynamic content
        await page.waitForTimeout(2000);
      }
    } else {
      // For non-SPA pages, shorter wait
      await page.waitForTimeout(500);
    }

    // Wait for any pending mutations
    await page.waitForFunction(
      () => {
        return new Promise((resolve) => {
          let timeout;
          const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(resolve, 500);
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
          });
          timeout = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, 1000);
        });
      },
      { timeout: 2000 }
    ).catch(() => {});
  } catch (error) {
    // If all else fails, wait a bit
    await page.waitForTimeout(1000);
  }
}

/**
 * Crawl a single page with retry logic
 */
async function crawlPage(context, url, retryCount = 0) {
  const page = await context.newPage();

  // Block unnecessary resources for faster crawling
  await page.route('**/*', route => {
    const resourceType = route.request().resourceType();
    const url = route.request().url();
    
    // Block more resource types for better performance
    if ([
      'image', 
      'font', 
      'media', 
      'stylesheet',
      'websocket',
      'manifest',
      'other'
    ].includes(resourceType)) {
      route.abort();
    } else if (resourceType === 'script') {
      // Allow scripts but block analytics/tracking
      if (url.includes('google-analytics') || 
          url.includes('googletagmanager') ||
          url.includes('facebook.net') ||
          url.includes('doubleclick') ||
          url.includes('analytics')) {
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
      { waitUntil: 'domcontentloaded', timeout: PAGE_NAVIGATION_TIMEOUT },
      { waitUntil: 'load', timeout: PAGE_NAVIGATION_TIMEOUT },
      { waitUntil: 'networkidle', timeout: PAGE_NAVIGATION_TIMEOUT }
    ];

    for (const strategy of strategies) {
      try {
        response = await page.goto(url, strategy);
        navigationSuccess = true;
        
        // Get status code
        if (response) {
          statusCode = response.status();
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
      throw new Error('Navigation failed with all strategies');
    }

    // Check if this is a hash route (SPA route)
    const isHashRoute = url.includes('#/');
    
    // For hash routes, wait for the router to navigate first
    if (isHashRoute) {
      // Wait for hash route to load
      await page.waitForTimeout(2000);
      
      // Wait for the route content to appear
      try {
        await page.waitForFunction(
          () => {
            // Check if there's actual content (not just loading/blank)
            const body = document.body;
            if (!body) return false;
            const text = body.textContent || '';
            // Should have some meaningful content (more than just whitespace)
            return text.trim().length > 50;
          },
          { timeout: 10000 }
        ).catch(() => {
          // Continue even if timeout
        });
      } catch {
        // Continue
      }
    }

    // Check for bot protection pages (Cloudflare, etc.) - but be less aggressive for hash routes
    const isBlocked = await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const bodyText = document.body?.textContent?.toLowerCase() || '';
      const pageContent = document.documentElement.innerHTML.toLowerCase();
      
      // Only check for actual Cloudflare elements, not just title text (which might be from base page)
      const hasCloudflareElements = (
        document.querySelector('#challenge-form') !== null ||
        document.querySelector('.cf-browser-verification') !== null ||
        document.querySelector('[data-ray]') !== null ||
        pageContent.includes('cf-browser-verification') ||
        pageContent.includes('ddos protection by cloudflare')
      );
      
      // For title/body, only flag if it's the ONLY content (not just part of base page)
      const isOnlyBlockedContent = (
        (title.includes('just a moment') || title.includes('checking your browser')) &&
        bodyText.length < 100 // Very little content suggests it's actually blocked
      );
      
      return hasCloudflareElements || isOnlyBlockedContent;
    });

    // If blocked, wait for challenge to resolve (but shorter wait for hash routes)
    if (isBlocked) {
      console.log(`⚠️ Bot protection detected for ${url}, waiting for challenge to resolve...`);
      
      // Shorter wait for hash routes (they might just be loading)
      const maxWaitTime = isHashRoute ? 5000 : 15000;
      const checkInterval = 500;
      const startTime = Date.now();
      let challengeResolved = false;
      
      while (Date.now() - startTime < maxWaitTime && !challengeResolved) {
        await page.waitForTimeout(checkInterval);
        
        challengeResolved = await page.evaluate(() => {
          // Check if Cloudflare elements are gone
          const hasElements = (
            document.querySelector('#challenge-form') !== null ||
            document.querySelector('.cf-browser-verification') !== null
          );
          
          if (hasElements) return false;
          
          // Check if there's actual content now
          const bodyText = document.body?.textContent || '';
          return bodyText.trim().length > 100;
        });
      }
      
      if (!challengeResolved && !isHashRoute) {
        console.warn(`⚠️ Challenge not resolved for ${url} after ${maxWaitTime}ms`);
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

    // Extract title with fallback
    let title = "Untitled";
    const blockedTitles = ['just a moment', 'checking your browser', 'please wait'];
    
    try {
      // For hash routes, try to get route-specific content first
      const pageInfo = await page.evaluate((isHashRoute) => {
        // Try multiple selectors for title
        const titleEl = document.querySelector("title");
        const h1El = document.querySelector("h1");
        const h2El = document.querySelector("h2");
        const metaTitle = document.querySelector('meta[property="og:title"]');
        
        let titleText = "";
        if (titleEl) titleText = titleEl.textContent?.trim() || "";
        if (!titleText && metaTitle) titleText = metaTitle.getAttribute('content')?.trim() || "";
        if (!titleText && h1El) titleText = h1El.textContent?.trim() || "";
        if (!titleText && h2El) titleText = h2El.textContent?.trim() || "";
        
        // For hash routes, also check for route-specific content
        if (isHashRoute && !titleText) {
          // Look for main content area
          const mainContent = document.querySelector('main') || 
                            document.querySelector('[role="main"]') ||
                            document.querySelector('.content') ||
                            document.querySelector('#content') ||
                            document.body;
          
          if (mainContent) {
            const h1 = mainContent.querySelector('h1');
            if (h1) titleText = h1.textContent?.trim() || "";
          }
        }
        
        return {
          title: titleText || "Untitled",
          hasContent: document.body && document.body.textContent.trim().length > 50
        };
      }, isHashRoute);
      
      title = pageInfo.title;
      
      // If title is still "Just a moment" or similar, use URL-based fallback immediately
      if (blockedTitles.some(blocked => title.toLowerCase().includes(blocked))) {
        // For hash routes, extract from hash path
        if (isHashRoute) {
          try {
            const urlObj = new URL(url);
            const hash = urlObj.hash?.substring(2); // Remove #/
            if (hash) {
              const hashParts = hash.split('/').filter(p => p);
              if (hashParts.length > 0) {
                const lastPart = hashParts[hashParts.length - 1];
                title = lastPart.replace(/-/g, ' ').replace(/_/g, ' ')
                  .replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
              } else {
                title = 'Home';
              }
            } else {
              title = 'Home';
            }
          } catch {
            title = 'Page';
          }
        } else {
          // For non-hash routes, try waiting a bit more
          console.warn(`⚠️ Title still shows bot protection for ${url}, using URL-based title...`);
          try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            if (pathParts.length > 0) {
              title = pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
            } else {
              title = 'Home';
            }
          } catch {
            title = 'Page';
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
            const hashParts = hash.split('/').filter(p => p);
            title = hashParts.length > 0
              ? hashParts[hashParts.length - 1].replace(/-/g, ' ').replace(/_/g, ' ')
                  .replace(/\b\w/g, l => l.toUpperCase())
              : 'Home';
          } else {
            title = 'Home';
          }
        } else {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split('/').filter(p => p);
          title = pathParts.length > 0 
            ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : 'Home';
        }
      } catch {
        title = "Untitled";
      }
    }

    // Extract comprehensive page data
    const pageData = await page.evaluate((isHashRoute) => {
      // Extract meta tags
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const metaRobots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || 'index,follow';
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
      
      // Extract content signals
      const h1 = document.querySelector('h1')?.textContent?.trim() || '';
      const h2Elements = document.querySelectorAll('h2');
      const h2Count = h2Elements.length;
      const bodyText = document.body?.textContent || '';
      const wordCount = bodyText.trim().split(/\s+/).filter(w => w.length > 0).length;
      
      // Extract links
      const allLinks = Array.from(document.querySelectorAll('a[href]')).map(a => {
        const href = a.getAttribute('href');
        if (!href) return null;
        try {
          const base = window.location.href;
          const resolvedUrl = new URL(href, base);
          return resolvedUrl.href;
        } catch {
          if (href.startsWith('#')) {
            return window.location.origin + window.location.pathname + href;
          }
          try {
            return new URL(href, window.location.origin).href;
          } catch {
            return null;
          }
        }
      }).filter(Boolean);
      
      // Detect SPA framework
      const isSPA = !!(window.React || window.Vue || window.angular || window.__NEXT_DATA__);
      const routeType = isHashRoute ? 'hash' : (isSPA ? 'history' : 'static');
      
      // Detect framework hints
      let frameworkHint = 'unknown';
      if (window.__NEXT_DATA__) frameworkHint = 'nextjs';
      else if (window.React) frameworkHint = 'react';
      else if (window.Vue) frameworkHint = 'vue';
      else if (window.angular) frameworkHint = 'angular';
      
      // Classify page intent (simple heuristic)
      let intent = 'informational';
      let pageType = 'page';
      const path = window.location.pathname.toLowerCase();
      if (path.includes('/blog') || path.includes('/article') || path.includes('/post')) {
        intent = 'informational';
        pageType = 'article';
      } else if (path.includes('/product') || path.includes('/shop')) {
        intent = 'transactional';
        pageType = 'product';
      } else if (path.includes('/learn') || path.includes('/tutorial') || path.includes('/guide')) {
        intent = 'informational';
        pageType = 'article';
      }
      
      return {
        meta: {
          description: metaDescription,
          robots: metaRobots,
          canonical: canonical,
          ogTitle: ogTitle
        },
        content_signals: {
          h1: h1,
          h2_count: h2Count,
          word_count: wordCount
        },
        links: allLinks,
        tech: {
          is_spa: isSPA,
          route_type: routeType,
          framework_hint: frameworkHint
        },
        classification: {
          intent: intent,
          page_type: pageType
        }
      };
    }, isHashRoute);

    // Extract all links for backward compatibility
    const links = pageData.links || [];

    // Build normalized URL path
    let normalizedUrl = url;
    try {
      const urlObj = new URL(url);
      normalizedUrl = urlObj.pathname + (isHashRoute ? urlObj.hash : '');
      if (!normalizedUrl || normalizedUrl === '/') {
        normalizedUrl = '/';
      }
    } catch {
      normalizedUrl = url;
    }

    return { 
      title, 
      links, 
      statusCode,
      pageData: {
        ...pageData,
        normalized_url: normalizedUrl
      }
    };
  } catch (error) {
    // Retry logic
    if (retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
      console.warn(`Retrying ${url} (attempt ${retryCount + 1}/${MAX_RETRIES}) after ${delay}ms:`, error.message);
      await page.close();
      await new Promise(resolve => setTimeout(resolve, delay));
      return crawlPage(context, url, retryCount + 1);
    }
    
    console.warn(`Error crawling ${url} after ${MAX_RETRIES} attempts:`, error.message);
    return { title: "Untitled", links: [], statusCode: 0, error: error.message };
  } finally {
    await page.close();
  }
}

/**
 * Main crawl function - adapted from the provided Playwright crawler
 */
async function crawlWebsite({ jobId, domain, maxDepth = 3, maxPages = 500, onProgress }) {
  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const baseDomain = new URL(baseUrl).hostname;

  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0, parentUrl: null }];
  const pages = [];
  const CONCURRENCY = 6;

  // Load robots.txt
  // const robots = await loadRobots(baseUrl);

  // Launch browser with stealth settings
  const browser = await chromium.launch({ 
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ]
  });
  
  // Create context with realistic browser fingerprint
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    permissions: [],
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    }
  });
  
  // Add stealth scripts to avoid detection
  await context.addInitScript(() => {
    // Override webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });
    
    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
    // Override chrome
    window.chrome = {
      runtime: {},
    };
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });

  try {
    while (queue.length > 0 && visited.size < maxPages) {
      const batch = queue.splice(0, CONCURRENCY);

      await Promise.all(
        batch.map(async (item) => {
          // For hash routes, preserve hash; otherwise normalize
          const hasHashRoute = item.url.includes('#/');
          const url = normalizeUrl(item.url, hasHashRoute);
          
          // Skip if already visited, invalid, or exceeds depth
          if (!url || visited.has(url) || item.depth > maxDepth) {
            return;
          }

          // Validate URL format
          try {
            new URL(url);
          } catch {
            console.warn(`Invalid URL skipped: ${url}`);
            return;
          }

          // Check robots.txt
          // if (!robots.isAllowed(url, '*')) {
          //   console.log(`🚫 Blocked by robots.txt: ${url}`);
          //   return;
          // }

          visited.add(url);
          console.log(`✔ [${item.depth}] ${url}`);

          // Add random delay between requests to appear more natural
          const delay = Math.floor(Math.random() * (REQUEST_DELAY_MAX - REQUEST_DELAY_MIN + 1)) + REQUEST_DELAY_MIN;
          await new Promise(resolve => setTimeout(resolve, delay));

          // Crawl the page
          const { title, links, statusCode = 200, error, pageData } = await crawlPage(context, url);

          // Clean up title
          let cleanedTitle = title;
          if (!cleanedTitle || cleanedTitle === 'ERROR: Error' || cleanedTitle === 'Error' || cleanedTitle === 'ERROR') {
            try {
              const urlObj = new URL(url);
              const hash = urlObj.hash?.substring(1);
              const pathParts = urlObj.pathname.split('/').filter(p => p);
              if (hash && hash.startsWith('/')) {
                cleanedTitle = hash.substring(1).split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
              } else if (hash) {
                cleanedTitle = hash.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
              } else {
                cleanedTitle = pathParts.length > 0 
                  ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                  : 'Home';
              }
            } catch {
              cleanedTitle = 'Page';
            }
          }

          // Store page in database
          try {
            const finalStatusCode = error ? (statusCode || 0) : statusCode;
            const finalTitle = error ? `ERROR: ${error}` : cleanedTitle;
            
            const pageResult = await pool.query(
              'INSERT INTO pages (job_id, url, depth, parent_url, title, status_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
              [jobId, url, item.depth, item.parentUrl, finalTitle, finalStatusCode]
            );

            pages.push({
              id: pageResult.rows[0].id,
              url: url,
              depth: item.depth,
              parentUrl: item.parentUrl,
              title: cleanedTitle,
              pageData: pageData || null, // Store enhanced page data
            });
          } catch (dbError) {
            console.error(`Error storing page ${url} in DB:`, dbError.message);
          }

          // Process links (only if page was successfully crawled)
          if (!error && links && links.length > 0) {
            for (const link of links) {
              try {
                // Validate link URL
                const linkUrl = new URL(link);
                
                // Check if this is a hash route
                const isHashRoute = link.includes('#/');
                const normalizedLink = normalizeUrl(link, isHashRoute);
                
                if (
                  normalizedLink &&
                  !visited.has(normalizedLink) &&
                  sameDomain(normalizedLink, baseUrl) &&
                  item.depth < maxDepth &&
                  linkUrl.protocol.startsWith('http') // Only HTTP/HTTPS
                ) {
                  queue.push({
                    url: normalizedLink,
                    depth: item.depth + 1,
                    parentUrl: url
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
        })
      );
    }
  } finally {
    await browser.close();
  }

  return pages;
}

module.exports = { crawlWebsite };