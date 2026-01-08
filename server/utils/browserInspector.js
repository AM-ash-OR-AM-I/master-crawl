#!/usr/bin/env node

/**
 * Browser Inspector Utility
 *
 * This script launches a headed browser with the same configuration as the crawler,
 * allowing you to manually visit and inspect pages that the crawler is crawling.
 *
 * This is particularly useful for:
 * - Verifying that the crawler correctly identifies 404/not found pages
 * - Debugging geo-blocked content (if run on a server with appropriate IP)
 * - Manually testing pages before/after crawling
 *
 * Usage:
 *   node server/utils/browserInspector.js <url>
 *   node server/utils/browserInspector.js --headless <url> [--no-screenshot]
 *   node server/utils/browserInspector.js --job <jobId> [--status-code <code>]
 *   node server/utils/browserInspector.js --job <jobId> --not-found
 *
 * Examples:
 *   node server/utils/browserInspector.js https://example.com/page
 *   node server/utils/browserInspector.js --headless https://example.com/page
 *   node server/utils/browserInspector.js --headless --no-screenshot https://example.com/page
 *   node server/utils/browserInspector.js --headless --job abc-123-def --not-found
 *   node server/utils/browserInspector.js --job abc-123-def --status-code 404
 */

const { chromium } = require("playwright");
const { pool } = require("../db/init");
const readline = require("readline");

// Parse command line arguments
const args = process.argv.slice(2);
let targetUrl = null;
let jobId = null;
let filterStatusCode = null;
let showNotFoundOnly = false;
let headlessMode = false; // Default to headed mode
let skipScreenshot = false; // Skip screenshots for faster operation

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--job" && args[i + 1]) {
    jobId = args[i + 1];
    i++;
  } else if (args[i] === "--status-code" && args[i + 1]) {
    filterStatusCode = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === "--not-found") {
    showNotFoundOnly = true;
  } else if (args[i] === "--headless") {
    headlessMode = true;
  } else if (args[i] === "--no-screenshot") {
    skipScreenshot = true;
  } else if (!args[i].startsWith("--")) {
    targetUrl = args[i];
  }
}

// Create readline interface for interactive mode
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

/**
 * Get the same browser context configuration as the crawler
 */
async function createBrowserContext(browser) {
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

  // Add stealth scripts to avoid detection (same as crawler)
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

  return context;
}

/**
 * Fetch URLs from a crawl job
 */
async function getUrlsFromJob(jobId, filterStatusCode, showNotFoundOnly) {
  try {
    let query = "SELECT url, status_code, title FROM pages WHERE job_id = $1";
    const params = [jobId];

    if (showNotFoundOnly) {
      query += " AND (status_code = 404 OR status_code IS NULL)";
    } else if (filterStatusCode !== null) {
      query += " AND status_code = $2";
      params.push(filterStatusCode);
    }

    query += " ORDER BY url";

    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error("Error fetching URLs from job:", error);
    throw error;
  }
}

/**
 * Open a URL in the browser and wait for user interaction
 */
async function openUrl(context, url, headless = false) {
  const page = await context.newPage();

  try {
    console.log(`\n🌐 Opening: ${url}`);
    if (headless) {
      console.log("   (Headless mode)");
      if (!skipScreenshot) {
        console.log("   (Screenshot will be taken)");
      }
    } else {
      console.log("   (Browser window should open - you can interact with it)");
    }

    // Navigate with faster strategy first - start with domcontentloaded for speed
    let response;
    const startTime = Date.now();
    try {
      // Try fast load first (domcontentloaded)
      response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000, // 30 seconds should be enough for most pages
      });
      const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`   ⚡ Loaded in ${loadTime}s`);

      // Quick wait for basic rendering (reduced from 2s to 500ms)
      await page.waitForTimeout(500);
    } catch (timeoutError) {
      // If domcontentloaded times out, try load event
      console.log("   ⏳ DOM timeout, trying full load...");
      try {
        response = await page.goto(url, {
          waitUntil: "load",
          timeout: 30000,
        });
        const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ⚡ Loaded in ${loadTime}s`);
        await page.waitForTimeout(500);
      } catch (loadError) {
        // Last resort - networkidle (slowest but most complete)
        console.log("   ⏳ Load timeout, waiting for network idle...");
        response = await page.goto(url, {
          waitUntil: "networkidle",
          timeout: 45000,
        });
        const loadTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   ⚡ Loaded in ${loadTime}s`);
      }
    }

    const statusCode = response?.status();
    console.log(`   Status Code: ${statusCode || "N/A"}`);

    // Get page title to verify it loaded
    const title = await page.title();
    console.log(`   Page Title: ${title || "N/A"}`);

    if (statusCode === 404) {
      console.log("   ⚠️  This is a 404 Not Found page");
    } else if (statusCode >= 400) {
      console.log(`   ⚠️  Error status: ${statusCode}`);
    } else {
      console.log("   ✅ Page loaded successfully");
    }

    // Check if page is actually visible/rendered
    const bodyText = await page.evaluate(() => {
      return document.body
        ? document.body.innerText.substring(0, 200)
        : "No body content";
    });
    console.log(`   Content preview: ${bodyText || "No content visible"}...`);

    // In headless mode, show details and optionally take screenshot
    if (headless) {
      // Get page details quickly (parallel evaluation)
      const pageInfo = await page.evaluate(() => {
        const body = document.body;
        return {
          url: window.location.href,
          title: document.title,
          bodyLength: body ? body.innerText.length : 0,
          hasContent: body && body.innerText.trim().length > 0,
          errorElements: document.querySelectorAll(
            '.error, .not-found, .404, [class*="error"], [class*="404"]'
          ).length,
        };
      });

      console.log(`\n   📄 Page Details:`);
      console.log(`      Final URL: ${pageInfo.url}`);
      console.log(`      Title: ${pageInfo.title}`);
      console.log(`      Content length: ${pageInfo.bodyLength} characters`);
      console.log(`      Has content: ${pageInfo.hasContent ? "Yes" : "No"}`);
      if (pageInfo.errorElements > 0) {
        console.log(
          `      ⚠️  Found ${pageInfo.errorElements} potential error elements`
        );
      }

      // Take screenshot only if not skipped (faster - viewport only, not fullPage)
      if (!skipScreenshot) {
        const screenshotStart = Date.now();
        const screenshotPath = `/tmp/browser-inspector-${Date.now()}.png`;
        try {
          // Use viewport screenshot (much faster than fullPage)
          await page.screenshot({
            path: screenshotPath,
            fullPage: false, // Faster - just viewport
          });
          const screenshotTime = (
            (Date.now() - screenshotStart) /
            1000
          ).toFixed(1);
          console.log(
            `\n   📸 Screenshot saved in ${screenshotTime}s: ${screenshotPath}`
          );
          console.log(`   💡 Download: scp user@server:${screenshotPath} .`);
        } catch (screenshotError) {
          console.log(`   ⚠️  Screenshot failed: ${screenshotError.message}`);
        }
      } else {
        console.log(
          `\n   ⏭️  Screenshot skipped (use without --no-screenshot to enable)`
        );
      }

      // Wait for user input
      const input = await question(
        "\n   [Press Enter for next, 'q' to quit, or type a URL to visit]: "
      );

      if (input.toLowerCase() === "q") {
        return false;
      }

      if (input.trim() && input.trim() !== "") {
        await page.close();
        return await openUrl(context, input.trim(), headless);
      }

      await page.close();
      return true;
    }

    // Headed mode - show browser window
    console.log(
      "\n   💡 Tip: If you see a black screen, the page might still be loading."
    );
    console.log("   Wait a few seconds and check the browser window.");
    console.log(
      "   You can also check the browser's developer console (F12) for errors.\n"
    );

    // Wait for user input
    const input = await question(
      "   [Press Enter for next, 'q' to quit, 's' for screenshot, or type a URL to visit]: "
    );

    if (input.toLowerCase() === "q") {
      return false; // Signal to stop
    }

    if (input.toLowerCase() === "s") {
      // Take a screenshot
      const screenshotPath = `/tmp/browser-inspector-${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`   📸 Screenshot saved to: ${screenshotPath}`);
      const continueInput = await question(
        "   [Press Enter to continue, 'q' to quit]: "
      );
      if (continueInput.toLowerCase() === "q") {
        await page.close();
        return false;
      }
      await page.close();
      return true;
    }

    if (input.trim() && input.trim() !== "") {
      // User wants to visit a different URL
      await page.close();
      return await openUrl(context, input.trim(), headless);
    }

    await page.close();
    return true; // Continue
  } catch (error) {
    console.error(`   ❌ Error loading page: ${error.message}`);
    await page.close();
    const input = await question("   [Press Enter to continue, 'q' to quit]: ");
    return input.toLowerCase() !== "q";
  }
}

/**
 * Main function
 */
async function main() {
  console.log("🔍 Browser Inspector - Using crawler's browser configuration\n");

  // Launch browser in headed mode (visible)
  let browser;
  try {
    browser = await chromium.launch({
      headless: false, // Show the browser window
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-gpu", // Disable GPU acceleration (helps on headless servers)
        "--disable-software-rasterizer", // Use software rendering
        "--disable-extensions", // Disable extensions for better performance
      ],
      // Increase timeouts
      timeout: 60000,
    });
    console.log("✅ Browser launched (headed mode)\n");

    // Check if we're on a headless server
    const display = process.env.DISPLAY;
    if (!display) {
      console.log("⚠️  WARNING: No DISPLAY environment variable detected!");
      console.log("   This might cause rendering issues.");
      console.log("   Solutions:");
      console.log(
        "   1. Use Xvfb: xvfb-run -a node server/utils/browserInspector.js <url>"
      );
      console.log("   2. Use X11 forwarding: ssh -X user@server");
      console.log("   3. Use VNC for remote desktop access");
      console.log("");
    }
  } catch (error) {
    console.error("❌ Failed to launch browser:", error.message);
    console.error("\n💡 Tip: If running on a server, you may need:");
    console.error("   - X11 forwarding: ssh -X user@server");
    console.error(
      "   - Or VNC/Xvfb for headless servers: xvfb-run -a node ..."
    );
    process.exit(1);
  }

  try {
    const context = await createBrowserContext(browser);

    if (jobId) {
      // Fetch URLs from job
      console.log(`📋 Fetching URLs from job: ${jobId}`);
      if (showNotFoundOnly) {
        console.log("   Filter: Only showing 404/not found pages");
      } else if (filterStatusCode !== null) {
        console.log(`   Filter: Status code ${filterStatusCode}`);
      }

      const urls = await getUrlsFromJob(
        jobId,
        filterStatusCode,
        showNotFoundOnly
      );

      if (urls.length === 0) {
        console.log("   No URLs found matching the criteria.");
        await browser.close();
        rl.close();
        return;
      }

      console.log(`   Found ${urls.length} URL(s)\n`);

      // Show list of URLs
      urls.forEach((row, index) => {
        console.log(
          `   ${index + 1}. ${row.url} (Status: ${row.status_code || "N/A"})`
        );
      });

      console.log("\n📌 Opening URLs one by one...\n");

      // Open each URL
      for (const row of urls) {
        const shouldContinue = await openUrl(context, row.url, headlessMode);
        if (!shouldContinue) {
          break;
        }
      }
    } else if (targetUrl) {
      // Open single URL
      await openUrl(context, targetUrl, headlessMode);
    } else {
      // Interactive mode - ask for URL
      console.log("💡 Interactive mode - Enter URLs to visit");
      console.log("   (Type 'q' or 'quit' to exit)\n");

      while (true) {
        const url = await question("Enter URL to visit (or 'q' to quit): ");

        if (url.toLowerCase() === "q" || url.toLowerCase() === "quit") {
          break;
        }

        if (url.trim()) {
          const shouldContinue = await openUrl(
            context,
            url.trim(),
            headlessMode
          );
          if (!shouldContinue) {
            break;
          }
        }
      }
    }

    await browser.close();
    console.log("\n✅ Browser closed. Goodbye!");
  } catch (error) {
    console.error("❌ Error:", error.message);
    await browser.close();
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

module.exports = { createBrowserContext };
