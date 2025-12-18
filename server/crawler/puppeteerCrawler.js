const puppeteer = require('puppeteer');
const { parse: parseRobots } = require('robots-parser');
const { URL } = require('url');
const { pool } = require('../db/init');

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
      ],
    });
  }
  return browserInstance;
}

async function checkRobotsTxt(baseUrl) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const https = require('https');
    const http = require('http');
    const url = require('url');
    
    return new Promise((resolve) => {
      const client = robotsUrl.startsWith('https') ? https : http;
      const req = client.get(robotsUrl, (res) => {
        if (res.statusCode === 200) {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const robots = parseRobots(robotsUrl, data);
              resolve(robots);
            } catch (e) {
              resolve(null);
            }
          });
        } else {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(null);
      });
    });
  } catch (error) {
    console.warn(`Could not fetch robots.txt for ${baseUrl}:`, error.message);
    return null;
  }
}

async function crawlWebsite({ jobId, domain, maxDepth, maxPages, onProgress }) {
  const baseUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const baseDomain = new URL(baseUrl).hostname;
  
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0, parentUrl: null }];
  const pages = [];
  
  let browser = null;
  let robots = null;
  
  try {
    browser = await getBrowser();
    robots = await checkRobotsTxt(baseUrl);
    
    while (queue.length > 0 && pages.length < maxPages) {
      const { url, depth, parentUrl } = queue.shift();
      
      if (depth > maxDepth) continue;
      if (visited.has(url)) continue;
      
      // Check robots.txt
      if (robots && !robots.isAllowed(url, 'SitemapBot')) {
        continue;
      }
      
      // Normalize URL (remove query params, but preserve hash)
      const normalizedUrl = normalizeUrl(url);
      if (visited.has(normalizedUrl)) continue;
      
      visited.add(normalizedUrl);
      visited.add(url);
      
      try {
        const page = await browser.newPage();
        
        // Set reasonable timeouts
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        
        // Set viewport for consistent rendering
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Navigate and wait for network idle (SPA support)
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 60000,
        });
        
        // Enhanced SPA rendering wait - wait for DOM to be ready
        await page.waitForFunction(
          () => document.readyState === 'complete',
          { timeout: 10000 }
        ).catch(() => {}); // Continue if timeout
        
        // Wait for any lazy-loaded content or dynamic rendering
        // Check if content is being loaded dynamically
        let previousLinkCount = 0;
        let stableCount = 0;
        
        // Poll for dynamically loaded links (SPA specific)
        for (let i = 0; i < 5; i++) {
          await page.waitForTimeout(2000); // Wait 2 seconds between checks
          
          const currentLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]')).length;
          });
          
          if (currentLinks === previousLinkCount) {
            stableCount++;
            if (stableCount >= 2) break; // Links stable for 2 checks
          } else {
            stableCount = 0;
            previousLinkCount = currentLinks;
          }
        }
        
        // Additional wait for any remaining async operations
        await page.waitForTimeout(3000);
        
        // Scroll to trigger lazy loading (common in SPAs)
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
        });
        await page.waitForTimeout(2000);
        
        // Scroll back to top
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1000);
        
        // Get page title
        const title = await page.evaluate(() => document.title || '');
        
        // Extract routes from JavaScript routers - preserve hash URLs as-is
        const { links, routes } = await page.evaluate((baseUrl) => {
          const linksSet = new Set();
          const routesSet = new Set();
          const base = new URL(baseUrl);
          
          // Extract standard anchor links
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          anchors.forEach(a => {
            const href = a.getAttribute('href');
            if (href) {
              // Handle hash-based routes - keep hash URLs as-is
              if (href.startsWith('#')) {
                // Preserve hash URL by combining with current location
                const fullHashUrl = window.location.origin + window.location.pathname + href;
                linksSet.add(fullHashUrl);
                routesSet.add(fullHashUrl);
              } else {
                // Handle relative URLs
                try {
                  const fullUrl = new URL(href, window.location.href);
                  linksSet.add(fullUrl.href);
                } catch (e) {
                  if (href.startsWith('/')) {
                    linksSet.add(window.location.origin + href);
                  } else if (href.startsWith('./') || !href.startsWith('#')) {
                    linksSet.add(new URL(href, window.location.href).href);
                  }
                }
              }
            }
          });
          
          // Extract routes from React Router
          try {
            // React Router v5/v6
            if (window.__REACT_ROUTER__ || window.ReactRouter) {
              const router = window.__REACT_ROUTER__ || window.ReactRouter;
              if (router.routes) {
                router.routes.forEach(route => {
                  if (route.path) {
                    // Check if it's a hash route
                    if (route.path.startsWith('#')) {
                      const fullHashUrl = base.origin + base.pathname + route.path;
                      linksSet.add(fullHashUrl);
                      routesSet.add(fullHashUrl);
                    } else {
                      const fullPath = base.origin + route.path;
                      linksSet.add(fullPath);
                      routesSet.add(fullPath);
                    }
                  }
                });
              }
            }
            
            // React Router DOM (check for route definitions)
            const reactRouterElements = document.querySelectorAll('[data-react-router], [data-route-path]');
            reactRouterElements.forEach(el => {
              const path = el.getAttribute('data-route-path') || el.getAttribute('data-react-router');
              if (path) {
                if (path.startsWith('#')) {
                  const fullHashUrl = base.origin + base.pathname + path;
                  linksSet.add(fullHashUrl);
                  routesSet.add(fullHashUrl);
                } else {
                  const fullPath = base.origin + path;
                  linksSet.add(fullPath);
                  routesSet.add(fullPath);
                }
              }
            });
          } catch (e) {}
          
          // Extract routes from Vue Router
          try {
            if (window.__VUE_ROUTER__ || window.$router) {
              const router = window.__VUE_ROUTER__ || window.$router;
              if (router.options && router.options.routes) {
                router.options.routes.forEach(route => {
                  if (route.path) {
                    // Check if it's a hash route
                    if (route.path.startsWith('#')) {
                      const fullHashUrl = base.origin + base.pathname + route.path;
                      linksSet.add(fullHashUrl);
                      routesSet.add(fullHashUrl);
                    } else {
                      const fullPath = base.origin + route.path;
                      linksSet.add(fullPath);
                      routesSet.add(fullPath);
                    }
                  }
                });
              }
            }
          } catch (e) {}
          
          // Extract routes from Angular Router
          try {
            if (window.ng && window.ng.probe) {
              const rootComponent = window.ng.probe(document.body);
              if (rootComponent && rootComponent.injector) {
                const router = rootComponent.injector.get(window.ng.router.Router);
                if (router && router.config) {
                  router.config.forEach(route => {
                    if (route.path) {
                      // Check if it's a hash route
                      if (route.path.startsWith('#')) {
                        const fullHashUrl = base.origin + base.pathname + route.path;
                        linksSet.add(fullHashUrl);
                        routesSet.add(fullHashUrl);
                      } else {
                        const fullPath = base.origin + route.path;
                        linksSet.add(fullPath);
                        routesSet.add(fullPath);
                      }
                    }
                  });
                }
              }
            }
          } catch (e) {}
          
          // Extract from router-based navigation elements
          // Note: v-bind:href is not a valid CSS selector (colon needs escaping)
          // Vue uses :href which compiles to href attribute, so we don't need to select it separately
          const routerElements = Array.from(document.querySelectorAll(
            '[data-link], [data-route], [data-navigate], [router-link], [ng-href]'
          ));
          routerElements.forEach(el => {
            const link = el.getAttribute('data-link') || 
                        el.getAttribute('data-route') || 
                        el.getAttribute('data-navigate') ||
                        el.getAttribute('router-link') ||
                        el.getAttribute('ng-href') ||
                        el.getAttribute('href') ||
                        el.getAttribute('to'); // Vue Router 'to' attribute
            
            if (link) {
              // Preserve hash routes as-is
              if (link.startsWith('#')) {
                const fullHashUrl = window.location.origin + window.location.pathname + link;
                linksSet.add(fullHashUrl);
                routesSet.add(fullHashUrl);
              } else if (!link.startsWith('#')) {
                try {
                  const fullUrl = new URL(link, window.location.href);
                  linksSet.add(fullUrl.href);
                } catch (e) {
                  if (link.startsWith('/')) {
                    linksSet.add(window.location.origin + link);
                  }
                }
              }
            }
          });
          
          // Extract hash routes from current URL and navigation - preserve as-is
          if (window.location.hash && window.location.hash !== '#') {
            const fullHashUrl = window.location.origin + window.location.pathname + window.location.hash;
            linksSet.add(fullHashUrl);
            routesSet.add(fullHashUrl);
          }
          
          // Try to extract routes from window.history or router state
          try {
            // Check for route definitions in global state
            if (window.__ROUTES__) {
              window.__ROUTES__.forEach(route => {
                const fullPath = base.origin + route;
                linksSet.add(fullPath);
                routesSet.add(fullPath);
              });
            }
          } catch (e) {}
          
          return {
            links: Array.from(linksSet),
            routes: Array.from(routesSet)
          };
        }, baseUrl);
        
        // Also try to discover routes by navigating through hash changes
        const hashRoutes = await discoverHashRoutes(page, baseUrl);
        links.push(...hashRoutes);
        
        // Programmatically discover routes by clicking navigation elements
        const discoveredRoutes = await discoverRoutesByNavigation(page, baseUrl);
        links.push(...discoveredRoutes);
        
        // Remove duplicates
        const uniqueLinks = [...new Set(links)];
        
        await page.close();
        
        // Store page in database
        const pageResult = await pool.query(
          'INSERT INTO pages (job_id, url, depth, parent_url, title, status_code) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
          [jobId, normalizedUrl, depth, parentUrl, title, 200]
        );
        
        pages.push({
          id: pageResult.rows[0].id,
          url: normalizedUrl,
          depth,
          parentUrl,
          title,
        });
        
        // Add new links to queue (same domain only)
        for (const link of uniqueLinks) {
          try {
            const linkUrl = new URL(link, baseUrl);
            const linkDomain = linkUrl.hostname;
            
            // Only crawl same domain
            if (linkDomain === baseDomain || linkDomain === `www.${baseDomain}` || `www.${linkDomain}` === baseDomain) {
              const normalizedLink = normalizeUrl(linkUrl.href);
              if (!visited.has(normalizedLink) && depth < maxDepth) {
                queue.push({
                  url: normalizedLink,
                  depth: depth + 1,
                  parentUrl: normalizedUrl,
                });
              }
            }
          } catch (e) {
            // Invalid URL, skip
          }
        }
        
        // Report progress
        if (onProgress && pages.length % 10 === 0) {
          await onProgress({ pagesCrawled: pages.length });
        }
      } catch (error) {
        console.warn(`Error crawling ${url}:`, error.message);
        // Store failed page
        try {
          await pool.query(
            'INSERT INTO pages (job_id, url, depth, parent_url, title, status_code) VALUES ($1, $2, $3, $4, $5, $6)',
            [jobId, normalizedUrl, depth, parentUrl, null, 0]
          );
        } catch (e) {
          // Ignore DB errors for failed pages
        }
      }
    }
    
    // Final progress update
    if (onProgress) {
      await onProgress({ pagesCrawled: pages.length });
    }
    
    return pages;
  } catch (error) {
    console.error('Crawler error:', error);
    throw error;
  }
}

/**
 * Discover hash-based routes by detecting navigation - preserve hash URLs as-is
 */
async function discoverHashRoutes(page, baseUrl) {
  const discoveredRoutes = new Set();
  const base = new URL(baseUrl);
  
  try {
    // Get all elements that might trigger hash navigation
    const hashNavElements = await page.evaluate(() => {
      const elements = [];
      
      // Find all clickable elements with hash hrefs
      document.querySelectorAll('a[href^="#"], [onclick*="hash"], [data-hash]').forEach(el => {
        const href = el.getAttribute('href');
        const hash = el.getAttribute('data-hash');
        const onclick = el.getAttribute('onclick');
        
        if (href && href.startsWith('#')) {
          elements.push(href);
        }
        if (hash) {
          elements.push('#' + hash);
        }
        if (onclick && onclick.includes('hash')) {
          const hashMatch = onclick.match(/['"]#([^'"]+)['"]/);
          if (hashMatch) {
            elements.push('#' + hashMatch[1]);
          }
        }
      });
      
      return [...new Set(elements)];
    });
    
    // Preserve hash routes as-is (keep the #)
    for (const hashRoute of hashNavElements) {
      if (hashRoute && hashRoute !== '#') {
        // Keep hash URL as-is: baseUrl + hashRoute
        const hashUrl = base.origin + base.pathname + hashRoute;
        discoveredRoutes.add(hashUrl);
      }
    }
    
    // Try to get current hash from page
    const currentHash = await page.evaluate(() => window.location.hash);
    if (currentHash && currentHash !== '#') {
      const hashUrl = base.origin + base.pathname + currentHash;
      discoveredRoutes.add(hashUrl);
    }
    
  } catch (error) {
    console.warn('Error discovering hash routes:', error.message);
  }
  
  return Array.from(discoveredRoutes);
}

/**
 * Discover routes by programmatically navigating through the SPA
 */
async function discoverRoutesByNavigation(page, baseUrl) {
  const discoveredRoutes = new Set();
  const base = new URL(baseUrl);
  
  try {
    // Get all navigation links and try to extract their target routes
    const navInfo = await page.evaluate((baseOrigin) => {
      const routes = new Set();
      const base = baseOrigin;
      
      // Find all navigation elements
      const navElements = document.querySelectorAll(
        'a[href], [router-link], [ng-href], [data-link], [data-route], nav a, [role="navigation"] a, [class*="nav"] a, [class*="menu"] a'
      );
      
      navElements.forEach(el => {
        let route = null;
        
        // Get route from various attributes
        route = el.getAttribute('href') || 
                el.getAttribute('router-link') ||
                el.getAttribute('ng-href') ||
                el.getAttribute('data-link') ||
                el.getAttribute('data-route') ||
                el.getAttribute('to'); // Vue Router
        
        if (route) {
          // Preserve hash routes as-is
          if (route.startsWith('#')) {
            // Keep hash URL: base + current pathname + hash
            const currentPath = window.location.pathname;
            routes.add(base + currentPath + route);
          } else if (route.startsWith('/')) {
            routes.add(base + route);
          } else if (!route.startsWith('http') && !route.startsWith('mailto:') && !route.startsWith('tel:')) {
            // Relative route
            routes.add(base + '/' + route);
          }
        }
      });
      
      // Also check for route definitions in JavaScript
      try {
        // React Router
        if (window.__REACT_ROUTER_CONFIG__) {
          window.__REACT_ROUTER_CONFIG__.forEach(route => {
            if (route.path) {
              routes.add(base + route.path);
            }
          });
        }
        
        // Vue Router
        if (window.__VUE_ROUTER_CONFIG__) {
          window.__VUE_ROUTER_CONFIG__.forEach(route => {
            if (route.path) {
              routes.add(base + route.path);
            }
          });
        }
        
        // Check for route arrays in window
        if (window.routes && Array.isArray(window.routes)) {
          window.routes.forEach(route => {
            if (typeof route === 'string') {
              routes.add(base + route);
            } else if (route.path) {
              routes.add(base + route.path);
            }
          });
        }
      } catch (e) {}
      
      return Array.from(routes);
    }, base.origin);
    
    navInfo.forEach(route => {
      if (route && route.startsWith(base.origin)) {
        discoveredRoutes.add(route);
      }
    });
    
    // Try clicking navigation elements to discover routes (limited to avoid infinite loops)
    try {
      const clickableNavs = await page.$$('nav a[href^="#"], [router-link], [data-link]');
      for (let i = 0; i < Math.min(clickableNavs.length, 10); i++) {
        try {
          const href = await page.evaluate(el => {
            return el.getAttribute('href') || 
                   el.getAttribute('router-link') ||
                   el.getAttribute('data-link') ||
                   el.getAttribute('to');
          }, clickableNavs[i]);
          
          if (href && href.startsWith('#')) {
            // Preserve hash URL as-is
            const hashUrl = base.origin + base.pathname + href;
            discoveredRoutes.add(hashUrl);
          }
        } catch (e) {
          // Skip if element is not clickable
        }
      }
    } catch (error) {
      // Ignore navigation errors
    }
    
  } catch (error) {
    console.warn('Error discovering routes by navigation:', error.message);
  }
  
  return Array.from(discoveredRoutes);
}

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // Preserve hash fragments - don't convert them
    // Only remove query params, keep hash as-is
    urlObj.search = '';
    // Keep hash: urlObj.hash stays as-is
    
    return urlObj.href;
  } catch (e) {
    // If URL parsing fails, preserve hash manually
    if (url.includes('#')) {
      const parts = url.split('#');
      const base = parts[0].split('?')[0];
      const hash = parts[1] ? '#' + parts[1] : '';
      return base + hash;
    }
    return url.split('?')[0];
  }
}

// Cleanup browser on shutdown
process.on('SIGTERM', async () => {
  if (browserInstance) {
    await browserInstance.close();
  }
});

module.exports = { crawlWebsite };

