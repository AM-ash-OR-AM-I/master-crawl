# Browser Inspector Guide

## Overview

The Browser Inspector utility allows you to manually visit and inspect pages that your crawler is crawling, using the **exact same browser configuration** as the crawler. This is particularly useful for:

- ✅ Verifying that the crawler correctly identifies 404/not found pages
- ✅ Debugging geo-blocked content (when run on a server with appropriate IP)
- ✅ Manually testing pages to ensure proper crawling behavior

## Important: Geo-Blocked Content

If the websites you're crawling are geo-blocked for Indian IPs, you have two options:

### Option 1: Run on Your Server (Recommended)

If your crawler runs on a server with a US IP address:

1. **SSH into your server:**

   ```bash
   ssh user@your-server
   ```

2. **If your server has a display (GUI):**

   ```bash
   cd /path/to/master-crawl
   node server/utils/browserInspector.js <url>
   ```

3. **If your server is headless (no GUI), use X11 forwarding:**

   ```bash
   # On your local machine (Mac/Linux)
   ssh -X user@your-server
   
   # Then on the server
   cd /path/to/master-crawl
   node server/utils/browserInspector.js <url>
   ```

4. **Alternative for headless servers - Use VNC or Xvfb:**

   ```bash
   # Install Xvfb
   sudo apt-get install xvfb
   
   # Run with Xvfb
   xvfb-run -a node server/utils/browserInspector.js <url>
   ```

### Option 2: Use Docker Container

If your crawler runs in Docker and the container has US IP access:

```bash
# Exec into the container
docker exec -it <container-name> bash

# Run the inspector
node server/utils/browserInspector.js <url>
```

**Note:** For Docker, you may need to install display dependencies or use X11 forwarding.

## Usage Examples

### 1. Visit a Single URL

```bash
node server/utils/browserInspector.js https://example.com/page
```

### 2. Visit URLs from a Crawl Job

```bash
# Visit all URLs from a job
node server/utils/browserInspector.js --job <job-id>

# Visit only 404 pages from a job
node server/utils/browserInspector.js --job <job-id> --not-found

# Visit pages with specific status code
node server/utils/browserInspector.js --job <job-id> --status-code 404
```

### 3. Interactive Mode

```bash
# Start interactive mode (no arguments)
node server/utils/browserInspector.js
```

Then enter URLs one by one when prompted.

## How It Works

1. **Launches a headed browser** (visible window) with the same configuration as your crawler:
   - US locale and timezone
   - Same user agent
   - Same headers
   - Same stealth scripts

2. **Opens the URL** and shows you the page in a real browser window

3. **Displays status information**:
   - HTTP status code
   - Whether it's a 404
   - Any errors

4. **Allows interaction**: You can click around, check the page, verify it's actually a 404, etc.

5. **Press Enter** to continue to the next URL, or type `q` to quit

## Finding Your Job ID

You can find job IDs from:

- The web dashboard (URL shows the job ID)
- Database query: `SELECT id, domain FROM crawl_jobs ORDER BY created_at DESC;`
- API: `GET /api/crawl` returns all jobs with their IDs

## Troubleshooting

### Black Screen / Page Not Rendering

If you see a black screen with just the page title but no content:

**This usually means you're on a headless server without proper display setup.**

**Solution 1: Use Xvfb (Recommended for headless servers)**
```bash
# Install Xvfb if not already installed
sudo apt-get install xvfb

# Run with Xvfb
xvfb-run -a node server/utils/browserInspector.js <url>
```

**Solution 2: Check if DISPLAY is set**
```bash
echo $DISPLAY
# If empty, you need X11 forwarding or Xvfb
```

**Solution 3: Use X11 Forwarding (if you have GUI access)**
```bash
# From your local machine
ssh -X user@your-server

# Then run the inspector
node server/utils/browserInspector.js <url>
```

**Solution 4: Wait longer for page load**
The script now waits up to 60 seconds and uses `networkidle` to ensure pages fully load. If pages are still slow:
- Check your network connection
- The website might be very slow to load
- Try the screenshot option ('s' key) to verify the page actually loaded

**Solution 5: Check browser console for errors**
- Press F12 in the browser window to open developer tools
- Check the Console tab for JavaScript errors
- Check the Network tab to see if resources are loading

### "Failed to launch browser" on server

If you get this error on a headless server:

1. **Install display dependencies:**

   ```bash
   sudo apt-get update
   sudo apt-get install -y \
     libnss3 \
     libatk-bridge2.0-0 \
     libdrm2 \
     libxkbcommon0 \
     libxcomposite1 \
     libxdamage1 \
     libxrandr2 \
     libgbm1 \
     libxss1 \
     libasound2
   ```

2. **Use Xvfb:**

   ```bash
   sudo apt-get install xvfb
   xvfb-run -a node server/utils/browserInspector.js <url>
   ```

### Browser window doesn't appear

- Make sure you're using `headless: false` (it's already set in the script)
- Check if X11 forwarding is working: `echo $DISPLAY`
- Try using VNC or a remote desktop solution

### Can't access geo-blocked sites

- Make sure you're running the script on a server with the appropriate IP (US IP for US-only sites)
- The script uses the same browser config as the crawler, so if the crawler can access it, this script should too (when run on the same server)

## Tips

- **For 404 verification**: Use `--not-found` flag to only show pages the crawler marked as 404, then manually verify each one
- **For debugging**: Use interactive mode to test specific URLs quickly
- **For batch checking**: Use `--job` with filters to go through multiple URLs systematically
