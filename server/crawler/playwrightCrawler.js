const { chromium } = require('playwright');
const robotsParser = require('robots-parser');
const { URL } = require('url');
const { pool, queryWithRetry } = require('../db/init');

let browserInstance = null;

// Configuration constants
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // Base delay in ms
const REQUEST_DELAY_MIN = 500; // Minimum delay between requests
const REQUEST_DELAY_MAX = 2000; // Maximum delay between requests
const SPA_WAIT_TIMEOUT = 5000; // Max wait for SPA content
const PAGE_NAVIGATION_TIMEOUT = 30000; // Increased timeout

/**
 * Normalize URL - preserve hash for SPAs and fragments, remove query params, trailing slash
 */
function normalizeUrl(url, preserveHash = false) {
  try {
    const u = new URL(url);
    // For SPAs, preserve hash routes (hash starting with #/)
    // Also preserve hash fragments (like #section-name) for page sections
    if (!preserveHash) {
      // Check if it's a hash route (#/) or a meaningful fragment
      const isHashRoute = u.hash && u.hash.startsWith('#/');
      const isFragment = u.hash && u.hash.length > 1 && !u.hash.startsWith('#/');
      
      // Only remove hash if it's not a route or fragment
      if (!isHashRoute && !isFragment) {
        u.hash = '';
      }
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
 * Interact with dropdown menus to reveal hidden links
 */
async function interactWithDropdowns(page) {
  try {
    const dropdownLinks = await safeEvaluate(page, () => {
      const links = [];
      
      // Find dropdown triggers (common patterns)
      const dropdownSelectors = [
        'button[aria-expanded]',
        'button[aria-haspopup="true"]',
        '.dropdown-toggle',
        '.dropdown-trigger',
        '[class*="dropdown"]',
        '[class*="menu-trigger"]',
        'nav a[href="#"]', // Links that might trigger dropdowns
      ];
      
      const triggers = [];
      dropdownSelectors.forEach(selector => {
        try {
          const elements = document.querySelectorAll(selector);
          elements.forEach(el => triggers.push(el));
        } catch {}
      });
      
      // Try to click dropdowns and extract links
      triggers.forEach(trigger => {
        try {
          // Check if it's a dropdown parent
          const parent = trigger.closest('li') || trigger.parentElement;
          if (parent) {
            const dropdownMenu = parent.querySelector('.dropdown-menu, .dropdown, [role="menu"], ul');
            if (dropdownMenu) {
              const menuLinks = dropdownMenu.querySelectorAll('a[href]');
              menuLinks.forEach(link => {
                const href = link.getAttribute('href');
                if (href && href !== '#' && !href.startsWith('javascript:')) {
                  try {
                    const resolvedUrl = new URL(href, window.location.href);
                    links.push(resolvedUrl.href);
                  } catch {
                    if (href.startsWith('/') || href.startsWith('http')) {
                      try {
                        links.push(new URL(href, window.location.origin).href);
                      } catch {}
                    }
                  }
                }
              });
            }
          }
        } catch {}
      });
      
      return [...new Set(links)]; // Remove duplicates
    }, []);
    
    // Also try clicking dropdowns to reveal content
    try {
      const dropdownButtons = await page.$$('button[aria-expanded="false"], .dropdown-toggle:not(.active)');
      for (const button of dropdownButtons.slice(0, 5)) { // Limit to 5 dropdowns
        try {
          await button.click({ timeout: 2000 });
          await page.waitForTimeout(500); // Wait for dropdown to open
        } catch {}
      }
    } catch {}
    
    return dropdownLinks;
  } catch (error) {
    console.warn('Error interacting with dropdowns:', error.message);
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
    const paginationLinks = await safeEvaluate(page, () => {
      const links = [];
      
      // Find pagination container
      const paginationContainer = document.querySelector('.pagination, [class*="pagination"], nav[aria-label*="pagination" i], [role="navigation"]');
      
      if (paginationContainer) {
        // Extract all pagination links (numbered pages, next, previous)
        const paginationElements = paginationContainer.querySelectorAll('a[href], button[data-page]');
        
        paginationElements.forEach(el => {
          try {
            let href = el.getAttribute('href');
            if (!href && el.hasAttribute('data-page')) {
              // Some pagination uses data attributes
              const pageNum = el.getAttribute('data-page');
              const currentUrl = new URL(window.location.href);
              // Try common pagination URL patterns
              if (currentUrl.searchParams.has('page')) {
                currentUrl.searchParams.set('page', pageNum);
                href = currentUrl.href;
              } else {
                href = `${currentUrl.pathname}?page=${pageNum}`;
              }
            }
            
            if (href && href !== '#' && !href.startsWith('javascript:')) {
              try {
                const resolvedUrl = new URL(href, window.location.href);
                // Only include pagination links (next, previous, numbered pages)
                const text = el.textContent?.toLowerCase() || '';
                const ariaLabel = el.getAttribute('aria-label')?.toLowerCase() || '';
                const isPaginationLink = 
                  text.includes('next') || 
                  text.includes('previous') || 
                  text.includes('prev') ||
                  ariaLabel.includes('next') ||
                  ariaLabel.includes('previous') ||
                  ariaLabel.includes('page') ||
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
        const href = nextLink.getAttribute('href');
        if (href) {
          try {
            links.push(new URL(href, window.location.href).href);
          } catch {}
        }
      }
      
      return [...new Set(links)]; // Remove duplicates
    }, []).catch(() => []);
    
    paginatedLinks.push(...paginationLinks);
    
    return [...new Set(paginatedLinks)]; // Remove duplicates
  } catch (error) {
    console.warn('Error handling pagination:', error.message);
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
    const fragments = await safeEvaluate(page, () => {
      const fragmentLinks = [];
      const allLinks = document.querySelectorAll('a[href^="#"]');
      
      allLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('#/')) {
          // This is a fragment (like #section-name), not a route
          const fragmentId = href.substring(1);
          const targetElement = document.getElementById(fragmentId) || 
                               document.querySelector(`[name="${fragmentId}"]`) ||
                               document.querySelector(`[id*="${fragmentId}"]`);
          
          if (targetElement) {
            // Check if this section has meaningful content
            const text = targetElement.textContent?.trim() || '';
            if (text.length > 50) { // Has meaningful content
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
    }, []);
    
    // Create full URLs for fragments
    fragments.forEach(fragment => {
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
    console.warn('Error capturing page fragments:', error.message);
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
        page.waitForFunction(
          () => document.readyState === 'complete',
          { timeout: 3000 }
        ),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
    } catch {
      // Continue if eval is disabled or timeout
    }

    // Check if page uses a common SPA framework
    const isSPA = await Promise.race([
      safeEvaluate(page, () => {
        return !!(
          window.React ||
          window.Vue ||
          window.angular ||
          window.__NEXT_DATA__ ||
          document.querySelector('[data-reactroot]') ||
          document.querySelector('[ng-app]') ||
          document.querySelector('[data-vue]')
        );
      }, false),
      new Promise(resolve => setTimeout(() => resolve(false), 2000))
    ]).catch(() => false);

    if (isSPA) {
      // Wait for network to be idle (with strict timeout)
      try {
        await Promise.race([
          page.waitForLoadState('networkidle', { timeout: SPA_WAIT_TIMEOUT }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Network idle timeout')), SPA_WAIT_TIMEOUT))
        ]);
      } catch {
        // Fallback: wait for any dynamic content (with timeout)
        await Promise.race([
          page.waitForTimeout(2000),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      }
    } else {
      // For non-SPA pages, shorter wait
      await Promise.race([
        page.waitForTimeout(500),
        new Promise(resolve => setTimeout(resolve, 500))
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
        safeEvaluate(page, () => {
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
        }, Promise.resolve()),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    } catch {
      // Ignore errors
    }
  } catch (error) {
    // If all else fails, wait a bit (with timeout)
    await Promise.race([
      page.waitForTimeout(1000),
      new Promise(resolve => setTimeout(resolve, 1000))
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
    if (error.message && error.message.includes('eval is disabled')) {
      // CSP has disabled eval, return fallback or empty result
      console.warn(`⚠️ eval disabled on page, using fallback`);
      return fallback;
    }
    throw error;
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
    let title = 'Untitled';
    try {
      const titleElement = page.locator('title').first();
      if (await titleElement.count() > 0) {
        title = await titleElement.textContent() || 'Untitled';
      } else {
        const h1Element = page.locator('h1').first();
        if (await h1Element.count() > 0) {
          title = await h1Element.textContent() || 'Untitled';
        }
      }
    } catch {}
    
    // Extract links using locator API (doesn't need eval)
    try {
      const linkElements = await page.locator('a[href]').all();
      for (const linkEl of linkElements) {
        try {
          const href = await linkEl.getAttribute('href');
          if (href && href !== '#' && !href.startsWith('javascript:')) {
            try {
              const resolvedUrl = new URL(href, url);
              links.push(resolvedUrl.href);
            } catch {
              // Skip invalid URLs
            }
          }
        } catch {}
      }
    } catch {}
    
    // Extract hash fragments
    const fragmentLinks = [];
    try {
      const fragmentElements = await page.locator('a[href^="#"]').all();
      for (const fragEl of fragmentElements) {
        try {
          const href = await fragEl.getAttribute('href');
          if (href && href !== '#' && !href.startsWith('#/')) {
            try {
              const urlObj = new URL(url);
              urlObj.hash = href;
              fragmentLinks.push(urlObj.href);
            } catch {}
          }
        } catch {}
      }
    } catch {}
    
    const allLinks = [...new Set([...links, ...fragmentLinks])];
    
    return {
      title: title.trim() || 'Untitled',
      links: allLinks,
      pageData: {
        meta: {
          description: '',
          canonical: '',
        },
        links: allLinks,
      }
    };
  } catch (error) {
    console.warn(`Error extracting data without eval:`, error.message);
    return {
      title: 'Untitled',
      links: [],
      pageData: { links: [] }
    };
  }
}

/**
 * Crawl a single page with retry logic and overall timeout protection
 */
async function crawlPage(context, url, retryCount = 0) {
  const PAGE_CRAWL_TIMEOUT = 60000; // 60 seconds max per page
  
  // Wrap entire crawl in timeout
  return Promise.race([
    crawlPageInternal(context, url, retryCount),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Page crawl timeout after ${PAGE_CRAWL_TIMEOUT}ms: ${url}`));
      }, PAGE_CRAWL_TIMEOUT);
    })
  ]).catch(error => {
    if (error.message.includes('timeout')) {
      console.warn(`⚠️ Page crawl timeout: ${url}`);
      return { title: "Timeout", links: [], statusCode: 0, error: error.message };
    }
    throw error;
  });
}

/**
 * Internal crawl page function
 */
async function crawlPageInternal(context, url, retryCount = 0) {
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
      
      // Wait for the route content to appear (with CSP-safe check)
      try {
        // Use a timeout wrapper since waitForFunction uses eval internally
        await Promise.race([
          page.waitForFunction(
            () => {
              // Check if there's actual content (not just loading/blank)
              const body = document.body;
              if (!body) return false;
              const text = body.textContent || '';
              // Should have some meaningful content (more than just whitespace)
              return text.trim().length > 50;
            },
            { timeout: 10000 }
          ),
          new Promise(resolve => setTimeout(resolve, 10000))
        ]).catch(() => {
          // Continue even if timeout or eval disabled
        });
      } catch {
        // Continue
      }
    }

    // Check for bot protection pages (Cloudflare, etc.) - but be less aggressive for hash routes
    const isBlocked = await safeEvaluate(page, () => {
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
    }, false);

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
        
        challengeResolved = await safeEvaluate(page, () => {
          // Check if Cloudflare elements are gone
          const hasElements = (
            document.querySelector('#challenge-form') !== null ||
            document.querySelector('.cf-browser-verification') !== null
          );
          
          if (hasElements) return false;
          
          // Check if there's actual content now
          const bodyText = document.body?.textContent || '';
          return bodyText.trim().length > 100;
        }, false);
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
    
    // Interact with dropdown menus to reveal hidden links (with timeout)
    const dropdownLinks = await Promise.race([
      interactWithDropdowns(page),
      new Promise(resolve => setTimeout(() => resolve([]), 5000))
    ]).catch(() => []);
    
    // Capture page fragments/sections (with timeout)
    const fragmentLinks = await Promise.race([
      capturePageFragments(page, url),
      new Promise(resolve => setTimeout(() => resolve([]), 3000))
    ]).catch(() => []);
    
    // Handle pagination if present (with timeout)
    const paginatedLinks = await Promise.race([
      handlePagination(page, url),
      new Promise(resolve => setTimeout(() => resolve([]), 5000))
    ]).catch(() => []);

    // Extract title with fallback
    let title = "Untitled";
    const blockedTitles = ['just a moment', 'checking your browser', 'please wait'];
    
    try {
      // For hash routes, try to get route-specific content first
      const pageInfo = await safeEvaluate(page, (isHashRoute) => {
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
      }, { title: "Untitled", hasContent: false }, isHashRoute);
      
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

    // Extract comprehensive page data (with CSP/eval fallback)
    let pageData;
    let links = [];
    // Note: title is already declared above
    
    try {
      pageData = await safeEvaluate(page, (isHashRoute) => {
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
      
      // Include hash fragments that are page sections (not routes)
      const fragmentLinks = Array.from(document.querySelectorAll('a[href^="#"]')).map(a => {
        const href = a.getAttribute('href');
        if (href && href !== '#' && !href.startsWith('#/')) {
          try {
            return window.location.origin + window.location.pathname + href;
          } catch {
            return null;
          }
        }
        return null;
      }).filter(Boolean);
      
      // Combine all links
      const combinedLinks = [...new Set([...allLinks, ...fragmentLinks])];
      
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
        links: combinedLinks,
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
    }, isHashRoute, null);
    
    // If eval is disabled, use fallback extraction method
    if (!pageData) {
      console.warn(`⚠️ Using fallback extraction for ${url} (eval disabled)`);
      const fallbackData = await extractPageDataWithoutEval(page, url);
      pageData = fallbackData.pageData || { links: [] };
      title = fallbackData.title || title;
      links = fallbackData.links || [];
    } else {
      // Extract all links for backward compatibility
      // Combine regular links, dropdown links, paginated links, and fragment links
      const allExtractedLinks = [
        ...(pageData.links || []),
        ...dropdownLinks,
        ...paginatedLinks,
        ...fragmentLinks.map(f => f.url).filter(Boolean)
      ];
      // Sort links deterministically to ensure consistent discovery order
      links = [...new Set(allExtractedLinks)].sort((a, b) => a.localeCompare(b)); // Remove duplicates and sort
    }

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
      // Check if error is due to eval being disabled (CSP)
      const isEvalDisabled = error.message && error.message.includes('eval is disabled');
      
      if (isEvalDisabled) {
        // Don't retry - eval won't work on retry either
        console.warn(`⚠️ eval disabled on ${url}, using fallback extraction`);
        try {
          const fallbackData = await extractPageDataWithoutEval(page, url);
          await page.close();
          return {
            title: fallbackData.title,
            links: fallbackData.links,
            statusCode: 200,
            pageData: fallbackData.pageData
          };
        } catch (fallbackError) {
          await page.close();
          return { title: "Untitled", links: [], statusCode: 0, error: 'eval disabled' };
        }
      }
      
      // Retry logic for other errors
      if (retryCount < MAX_RETRIES) {
        const delay = RETRY_DELAY_BASE * Math.pow(2, retryCount);
        console.warn(`Retrying ${url} (attempt ${retryCount + 1}/${MAX_RETRIES}) after ${delay}ms:`, error.message);
        await page.close();
        await new Promise(resolve => setTimeout(resolve, delay));
        return crawlPage(context, url, retryCount + 1);
      }
      
      console.warn(`Error crawling ${url} after ${MAX_RETRIES} attempts:`, error.message);
      await page.close();
      return { title: "Untitled", links: [], statusCode: 0, error: error.message };
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
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 10; // Stop if too many consecutive failures
    let lastProgressTime = Date.now();
    const PROGRESS_TIMEOUT = 300000; // 5 minutes without progress
    
    while (queue.length > 0 && visited.size < maxPages) {
      // Check for timeout without progress
      if (Date.now() - lastProgressTime > PROGRESS_TIMEOUT) {
        console.warn(`⚠️ Crawl timeout: No progress for ${PROGRESS_TIMEOUT / 1000}s, stopping crawl`);
        break;
      }
      
      // Check for too many consecutive failures
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`⚠️ Too many consecutive failures (${consecutiveFailures}), stopping crawl`);
        break;
      }
      
      // Sort queue deterministically before processing to ensure consistent order
      queue.sort((a, b) => {
        // Sort by depth first, then by URL
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.url.localeCompare(b.url);
      });
      
      const batch = queue.splice(0, CONCURRENCY);

      // Use Promise.allSettled to prevent one hanging page from blocking others
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            // For hash routes, preserve hash; otherwise normalize
            const hasHashRoute = item.url.includes('#/');
            const url = normalizeUrl(item.url, hasHashRoute);
            
            // Skip if already visited, invalid, or exceeds depth
            if (!url || visited.has(url) || item.depth > maxDepth) {
              return { success: true, skipped: true };
            }

            // Validate URL format
            try {
              new URL(url);
            } catch {
              console.warn(`Invalid URL skipped: ${url}`);
              return { success: true, skipped: true };
            }

            // Check robots.txt
            // if (!robots.isAllowed(url, '*')) {
            //   console.log(`🚫 Blocked by robots.txt: ${url}`);
            //   return;
            // }

            visited.add(url);
            console.log(`✔ [${item.depth}] ${url}`);

            // Add deterministic delay between requests (based on URL hash for consistency)
            // This ensures the same URL always gets the same delay, making crawling more deterministic
            const urlHash = url.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            const delay = REQUEST_DELAY_MIN + (urlHash % (REQUEST_DELAY_MAX - REQUEST_DELAY_MIN + 1));
            await new Promise(resolve => setTimeout(resolve, delay));

            // Crawl the page (with timeout protection)
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
            
            const pageResult = await queryWithRetry(
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
            // Sort links deterministically before processing to ensure consistent order
            const sortedLinks = [...links].sort((a, b) => {
              // Sort by URL to ensure deterministic order
              return a.localeCompare(b);
            });
            
            for (const link of sortedLinks) {
              try {
                // Validate link URL
                const linkUrl = new URL(link);
                
                // Check if this is a hash route (#/) or hash fragment (#section)
                const isHashRoute = link.includes('#/');
                const isHashFragment = link.includes('#') && !link.includes('#/') && link.split('#')[1]?.length > 0;
                const preserveHash = isHashRoute || isHashFragment;
                const normalizedLink = normalizeUrl(link, preserveHash);
                
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
          
          return { success: true };
          } catch (error) {
            // Handle errors within the async function
            console.warn(`⚠️ Error crawling ${item.url}:`, error.message);
            try {
              await queryWithRetry(
                'INSERT INTO pages (job_id, url, depth, parent_url, title, status_code) VALUES ($1, $2, $3, $4, $5, $6)',
                [jobId, item.url, item.depth, item.parentUrl, `ERROR: ${error.message}`, 0]
              );
            } catch {}
            return { success: false, error: error.message };
          }
        })
      );
      
      // Process results - handle both fulfilled and rejected promises
      let batchSuccessCount = 0;
      results.forEach((result) => {
        if (result.status === 'rejected') {
          consecutiveFailures++;
          console.warn(`⚠️ Promise rejected:`, result.reason?.message || 'Unknown error');
        } else if (result.value) {
          if (result.value.success && !result.value.skipped) {
            consecutiveFailures = 0; // Reset on success
            batchSuccessCount++;
            lastProgressTime = Date.now(); // Update progress time
          } else if (!result.value.success) {
            consecutiveFailures++;
          }
        }
      });
    }
  } finally {
    await browser.close();
  }

  return pages;
}

module.exports = { crawlWebsite };