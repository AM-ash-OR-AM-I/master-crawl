const { pool } = require("../db/init");
const XLSX = require("xlsx");

/**
 * Generate XML sitemap from pages
 */
function generateXMLSitemap(pages, baseUrl) {
  const url = new URL(baseUrl);
  const base = `${url.protocol}//${url.host}`;
  const now = new Date().toISOString().split("T")[0]; // YYYY-MM-DD format

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

  for (const page of pages) {
    xml += "  <url>\n";
    xml += `    <loc>${escapeXML(page.url)}</loc>\n`;
    xml += `    <lastmod>${now}</lastmod>\n`;
    xml += `    <changefreq>weekly</changefreq>\n`;
    xml += `    <priority>${calculatePriority(page.depth)}</priority>\n`;
    xml += "  </url>\n";
  }

  xml += "</urlset>";
  return xml;
}

/**
 * Generate tree diagram representation (improved to match revize-ai format)
 */
function generateTreeDiagram(pages, baseUrl) {
  if (!pages || pages.length === 0) {
    return `${baseUrl}\n└── (No pages found)`;
  }

  const url = new URL(baseUrl);
  const base = `${url.protocol}//${url.host}`;

  // Find root page (homepage)
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
    }) || pages[0];

  // Build a map of pages by URL for quick lookup
  const pageMap = new Map();
  pages.forEach((page) => {
    pageMap.set(page.url, {
      ...page,
      children: [],
    });
  });

  // Build parent-child relationships
  const rootNodes = [];
  pages.forEach((page) => {
    const node = pageMap.get(page.url);
    if (page.parentUrl && pageMap.has(page.parentUrl)) {
      const parent = pageMap.get(page.parentUrl);
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else if (
      page.url === rootPage?.url ||
      (!page.parentUrl && page.depth === 0)
    ) {
      rootNodes.push(node);
    } else {
      // Orphan page - add to root
      rootNodes.push(node);
    }
  });

  // If no root nodes found, use the first page
  if (rootNodes.length === 0 && pages.length > 0) {
    rootNodes.push(pageMap.get(pages[0].url));
  }

  // Convert to text tree
  let output = `${base}\n`;

  // Build tree text from root nodes
  rootNodes.forEach((node, idx) => {
    const isLast = idx === rootNodes.length - 1;
    output += buildTreeTextFromNode(node, "", isLast);
  });

  return output;
}

/**
 * Build tree text from a node (recursive)
 */
function buildTreeTextFromNode(node, prefix, isLast) {
  if (!node) return "";

  let output = "";
  const title =
    node.title &&
    node.title !== "ERROR: Error" &&
    node.title !== "Error" &&
    node.title !== "ERROR"
      ? node.title
      : (() => {
          try {
            const urlObj = new URL(node.url);
            const hash = urlObj.hash?.substring(1);
            const pathParts = urlObj.pathname.split("/").filter((p) => p);
            if (hash && hash.startsWith("/")) {
              return (
                hash
                  .substring(1)
                  .split("/")
                  .pop()
                  ?.replace(/-/g, " ")
                  .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page"
              );
            }
            return pathParts.length > 0
              ? pathParts[pathParts.length - 1]
                  .replace(/-/g, " ")
                  .replace(/\b\w/g, (l) => l.toUpperCase())
              : "Home";
          } catch {
            return "Page";
          }
        })();

  const connector = isLast ? "└── " : "├── ";
  output += prefix + connector + `📄 ${title}\n`;
  output += prefix + (isLast ? "    " : "│   ") + `   ${node.url}\n`;

  // Add children
  if (node.children && node.children.length > 0) {
    node.children.forEach((child, idx) => {
      const isLastChild = idx === node.children.length - 1;
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      output += buildTreeTextFromNode(child, childPrefix, isLastChild);
    });
  }

  return output;
}

// Legacy function kept for backward compatibility (not used in new implementation)
function buildTreeText(node, prefix, isLast) {
  let output = "";
  const entries = Object.entries(node);

  for (let idx = 0; idx < entries.length; idx++) {
    const [key, value] = entries[idx];
    const isLastItem = idx === entries.length - 1;
    const currentPrefix = isLast ? "└── " : "├── ";
    const nextPrefix = isLast ? "    " : "│   ";

    output += prefix + currentPrefix + key;
    if (value.pages && value.pages.length > 0) {
      output += ` (${value.pages.length} page${
        value.pages.length > 1 ? "s" : ""
      })`;
    }
    output += "\n";

    if (value.pages && value.pages.length > 0) {
      for (let pIdx = 0; pIdx < value.pages.length; pIdx++) {
        const page = value.pages[pIdx];
        const isLastPage =
          pIdx === value.pages.length - 1 &&
          Object.keys(value.children).length === 0;
        const pagePrefix = prefix + (isLastItem ? "    " : "│   ");
        const pageTitle =
          page.title &&
          page.title !== "ERROR: Error" &&
          page.title !== "Error" &&
          page.title !== "ERROR"
            ? page.title
            : "Untitled";
        output +=
          pagePrefix + (isLastPage ? "└── " : "├── ") + `📄 ${pageTitle}\n`;
        output +=
          pagePrefix + (isLastPage ? "    " : "│   ") + `   ${page.url}\n`;
      }
    }

    if (Object.keys(value.children).length > 0) {
      const childPrefix = prefix + (isLastItem ? "    " : "│   ");
      output += buildTreeText(value.children, childPrefix, isLastItem);
    }
  }

  return output;
}

/**
 * Generate JSON sitemap (already exists, but ensure it's complete)
 */
/**
 * Generate JSON sitemap for architecture redesign
 * Separates working pages from broken links for clean planning
 */
function generateJSONSitemap(pages) {
  const workingPages = [];
  const brokenLinks = [];

  pages.forEach((page) => {
    const title = page.title || "";
    const isError =
      title.startsWith("ERROR:") || title === "Error" || title === "ERROR";

    if (isError) {
      // Extract error type
      let errorType = "Unknown Error";
      if (title.includes("404")) errorType = "404 Not Found";
      else if (title.includes("403")) errorType = "403 Forbidden";
      else if (title.includes("500")) errorType = "500 Server Error";
      else if (title.includes("timeout")) errorType = "Timeout";
      else if (title.startsWith("ERROR:"))
        errorType = title.replace("ERROR:", "").trim() || "Error";

      // Generate URL-based title
      let suggestedTitle = "Page";
      try {
        const urlObj = new URL(page.url);
        const pathParts = urlObj.pathname.split("/").filter((p) => p);
        if (pathParts.length > 0) {
          suggestedTitle = pathParts[pathParts.length - 1]
            .replace(/-/g, " ")
            .replace(/_/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase());
        }
      } catch {}

      brokenLinks.push({
        url: page.url,
        errorType: errorType,
        suggestedTitle: suggestedTitle,
        parentUrl: page.parentUrl,
        depth: page.depth,
        recommendation:
          errorType === "404 Not Found" ? "Redirect or Remove" : "Investigate",
      });
    } else {
      // Clean up title
      let cleanTitle = title;
      if (!cleanTitle || cleanTitle === "Untitled") {
        try {
          const urlObj = new URL(page.url);
          const hash = urlObj.hash?.substring(1);
          const pathParts = urlObj.pathname.split("/").filter((p) => p);
          if (hash && hash.startsWith("/")) {
            cleanTitle =
              hash
                .substring(1)
                .split("/")
                .pop()
                ?.replace(/-/g, " ")
                .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page";
          } else {
            cleanTitle =
              pathParts.length > 0
                ? pathParts[pathParts.length - 1]
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (l) => l.toUpperCase())
                : "Home";
          }
        } catch {
          cleanTitle = "Page";
        }
      }

      workingPages.push({
        url: page.url,
        title: cleanTitle,
        depth: page.depth,
        parentUrl: page.parentUrl,
      });
    }
  });

  return {
    version: "1.0",
    generatedAt: new Date().toISOString(),
    summary: {
      totalPages: workingPages.length,
      brokenLinks: brokenLinks.length,
    },
    pages: workingPages,
    issues: {
      brokenLinks: brokenLinks,
    },
  };
}

function escapeXML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function calculatePriority(depth) {
  // Homepage = 1.0, depth 1 = 0.8, depth 2 = 0.6, etc.
  return Math.max(0.1, 1.0 - depth * 0.2).toFixed(1);
}

/**
 * Generate Excel sitemap from pages with hierarchical structure
 * For sitemap architecture redesign:
 * - Sheet 1: "Sitemap" - Clean hierarchy of working pages only
 * - Sheet 2: "Broken Links" - 404s and errors to fix/redirect
 */
function generateExcelSitemap(pages, baseUrl) {
  // Separate working pages from error pages
  const workingPages = [];
  const brokenLinks = [];

  pages.forEach((page) => {
    const title = page.title || "";
    const isError =
      title.startsWith("ERROR:") || title === "Error" || title === "ERROR";

    if (isError) {
      // Extract error type
      let errorType = "Unknown Error";
      if (title.includes("404")) errorType = "404 Not Found";
      else if (title.includes("403")) errorType = "403 Forbidden";
      else if (title.includes("500")) errorType = "500 Server Error";
      else if (title.includes("timeout")) errorType = "Timeout";
      else if (title.startsWith("ERROR:"))
        errorType = title.replace("ERROR:", "").trim() || "Error";

      // Generate URL-based title for the broken link
      let suggestedTitle = "Page";
      try {
        const urlObj = new URL(page.url);
        const pathParts = urlObj.pathname.split("/").filter((p) => p);
        if (pathParts.length > 0) {
          suggestedTitle = pathParts[pathParts.length - 1]
            .replace(/-/g, " ")
            .replace(/_/g, " ")
            .replace(/\b\w/g, (l) => l.toUpperCase());
        }
      } catch {}

      // Extract original href from page object (now comes from database)
      const originalHref = page.originalHref || null;

      brokenLinks.push({
        url: page.url,
        errorType: errorType,
        suggestedTitle: suggestedTitle,
        parentUrl: page.parentUrl || "",
        depth: page.depth,
        originalHref: originalHref,
      });
    } else {
      // Clean up title
      let cleanTitle = title;
      if (!cleanTitle || cleanTitle === "Untitled") {
        try {
          const urlObj = new URL(page.url);
          const hash = urlObj.hash?.substring(1);
          const pathParts = urlObj.pathname.split("/").filter((p) => p);
          if (hash && hash.startsWith("/")) {
            cleanTitle =
              hash
                .substring(1)
                .split("/")
                .pop()
                ?.replace(/-/g, " ")
                .replace(/\b\w/g, (l) => l.toUpperCase()) || "Page";
          } else {
            cleanTitle =
              pathParts.length > 0
                ? pathParts[pathParts.length - 1]
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (l) => l.toUpperCase())
                : "Home";
          }
        } catch {
          cleanTitle = "Page";
        }
      }

      workingPages.push({
        url: page.url,
        title: cleanTitle,
        depth: page.depth,
        parentUrl: page.parentUrl || "",
      });
    }
  });

  // Build a map of working pages by URL for parent lookup
  const pageMap = new Map();
  workingPages.forEach((page) => {
    pageMap.set(page.url, page);
  });

  // Build tree structure for proper ordering (working pages only)
  const rootNodes = [];
  const childrenMap = new Map();

  // Initialize children map
  workingPages.forEach((page) => {
    childrenMap.set(page.url, []);
  });

  // Build parent-child relationships
  workingPages.forEach((page) => {
    if (page.parentUrl && pageMap.has(page.parentUrl)) {
      const children = childrenMap.get(page.parentUrl) || [];
      children.push(page);
      childrenMap.set(page.parentUrl, children);
    } else if (page.depth === 0 || !page.parentUrl) {
      rootNodes.push(page);
    } else {
      // Orphan - add to root
      rootNodes.push(page);
    }
  });

  // Flatten tree in DFS order (to match tree view order)
  const orderedPages = [];
  const flattenTree = (node, ancestorTitles = []) => {
    orderedPages.push({ page: node, ancestorTitles: [...ancestorTitles] });

    const children = childrenMap.get(node.url) || [];
    // Sort children by title for consistent ordering
    children.sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    children.forEach((child) => {
      flattenTree(child, [...ancestorTitles, node.title]);
    });
  };

  // Sort root nodes and flatten
  rootNodes.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  rootNodes.forEach((root) => flattenTree(root, []));

  // Create rows with full hierarchy path (working pages only)
  const hierarchicalRows = orderedPages.map(({ page, ancestorTitles }) => {
    const depth = page.depth || 0;
    const fullPath = [...ancestorTitles];

    const row = {
      "Top Level Navigation Landing Page (1st level)": "",
      "2nd Level Subpage": "",
      "3rd Level Subpage": "",
      "4th Level Subpage": "",
      "5th Level Subpage": "",
      "6th Level Subpage": "",
      "7th Level Subpage": "",
      URL: page.url,
      Notes: "",
    };

    // Fill in ancestor titles
    fullPath.forEach((title, idx) => {
      if (idx === 0)
        row["Top Level Navigation Landing Page (1st level)"] = title;
      else if (idx === 1) row["2nd Level Subpage"] = title;
      else if (idx === 2) row["3rd Level Subpage"] = title;
      else if (idx === 3) row["4th Level Subpage"] = title;
      else if (idx === 4) row["5th Level Subpage"] = title;
      else if (idx === 5) row["6th Level Subpage"] = title;
      else if (idx >= 6) row["7th Level Subpage"] = title;
    });

    // Place current page title at its depth level
    if (depth === 0)
      row["Top Level Navigation Landing Page (1st level)"] = page.title;
    else if (depth === 1) row["2nd Level Subpage"] = page.title;
    else if (depth === 2) row["3rd Level Subpage"] = page.title;
    else if (depth === 3) row["4th Level Subpage"] = page.title;
    else if (depth === 4) row["5th Level Subpage"] = page.title;
    else if (depth === 5) row["6th Level Subpage"] = page.title;
    else if (depth >= 6) row["7th Level Subpage"] = page.title;

    return row;
  });

  // Create broken links rows
  const brokenLinksRows = brokenLinks.map((link) => {
    // Find parent page title if it exists
    let foundOnPage = link.parentUrl;
    const parentPage = pageMap.get(link.parentUrl);
    if (parentPage) {
      foundOnPage = `${parentPage.title} (${link.parentUrl})`;
    }

    return {
      "Broken URL": link.url,
      "Error Type": link.errorType,
      "Suggested Title": link.suggestedTitle,
      "Found On Page": foundOnPage,
      "Original Href": link.originalHref || "",
      Depth: link.depth,
      Recommendation:
        link.errorType === "404 Not Found"
          ? "Redirect or Remove"
          : "Investigate",
    };
  });

  // Create workbook
  const workbook = XLSX.utils.book_new();

  // Sheet 1: Clean Sitemap (working pages only)
  const sitemapSheet = XLSX.utils.json_to_sheet(hierarchicalRows);
  sitemapSheet["!cols"] = [
    { wch: 45 }, // 1st level
    { wch: 40 }, // 2nd level
    { wch: 40 }, // 3rd level
    { wch: 40 }, // 4th level
    { wch: 40 }, // 5th level
    { wch: 40 }, // 6th level
    { wch: 40 }, // 7th level
    { wch: 60 }, // URL
    { wch: 30 }, // Notes
  ];
  XLSX.utils.book_append_sheet(workbook, sitemapSheet, "Sitemap");

  // Sheet 2: Broken Links (if any)
  if (brokenLinksRows.length > 0) {
    const brokenLinksSheet = XLSX.utils.json_to_sheet(brokenLinksRows);
    brokenLinksSheet["!cols"] = [
      { wch: 60 }, // Broken URL
      { wch: 20 }, // Error Type
      { wch: 30 }, // Suggested Title
      { wch: 60 }, // Found On Page
      { wch: 30 }, // Original Href
      { wch: 10 }, // Depth
      { wch: 25 }, // Recommendation
    ];
    XLSX.utils.book_append_sheet(workbook, brokenLinksSheet, "Broken Links");
  }

  // Sheet 3: Sitemap URLs (uses URLs instead of titles)
  // Build ancestor URLs map for each page
  const buildAncestorUrls = (page) => {
    const ancestorUrls = [];
    let currentUrl = page.parentUrl;
    const visited = new Set();

    while (
      currentUrl &&
      ancestorUrls.length < page.depth &&
      !visited.has(currentUrl)
    ) {
      visited.add(currentUrl);
      const parentPage = pageMap.get(currentUrl);
      if (parentPage) {
        ancestorUrls.unshift(parentPage.url);
        currentUrl = parentPage.parentUrl;
      } else {
        break;
      }
    }

    return ancestorUrls;
  };

  // Convert URL to relative or keep absolute based on baseUrl
  const getUrlDisplay = (url) => {
    try {
      const urlObj = new URL(url);
      const baseUrlObj = new URL(baseUrl);

      // If same origin, return relative path
      if (urlObj.origin === baseUrlObj.origin) {
        return urlObj.pathname + urlObj.search + urlObj.hash;
      }
      // Otherwise return full URL
      return url;
    } catch {
      return url;
    }
  };

  const sitemapUrlsRows = orderedPages.map(({ page, ancestorTitles }) => {
    const depth = page.depth || 0;
    const ancestorUrls = buildAncestorUrls(page);

    const row = {
      "Top Level Navigation Landing Page (1st level)": "",
      "2nd Level Subpage": "",
      "3rd Level Subpage": "",
      "4th Level Subpage": "",
      "5th Level Subpage": "",
      "6th Level Subpage": "",
      "7th Level Subpage": "",
      URL: page.url,
      Notes: "",
    };

    // Fill in ancestor URLs
    ancestorUrls.forEach((ancestorUrl, idx) => {
      const displayUrl = getUrlDisplay(ancestorUrl);
      if (idx === 0)
        row["Top Level Navigation Landing Page (1st level)"] = displayUrl;
      else if (idx === 1) row["2nd Level Subpage"] = displayUrl;
      else if (idx === 2) row["3rd Level Subpage"] = displayUrl;
      else if (idx === 3) row["4th Level Subpage"] = displayUrl;
      else if (idx === 4) row["5th Level Subpage"] = displayUrl;
      else if (idx === 5) row["6th Level Subpage"] = displayUrl;
      else if (idx >= 6) row["7th Level Subpage"] = displayUrl;
    });

    // Place current page URL at its depth level
    const currentDisplayUrl = getUrlDisplay(page.url);
    if (depth === 0)
      row["Top Level Navigation Landing Page (1st level)"] = currentDisplayUrl;
    else if (depth === 1) row["2nd Level Subpage"] = currentDisplayUrl;
    else if (depth === 2) row["3rd Level Subpage"] = currentDisplayUrl;
    else if (depth === 3) row["4th Level Subpage"] = currentDisplayUrl;
    else if (depth === 4) row["5th Level Subpage"] = currentDisplayUrl;
    else if (depth === 5) row["6th Level Subpage"] = currentDisplayUrl;
    else if (depth >= 6) row["7th Level Subpage"] = currentDisplayUrl;

    return row;
  });

  const sitemapUrlsSheet = XLSX.utils.json_to_sheet(sitemapUrlsRows);
  sitemapUrlsSheet["!cols"] = [
    { wch: 45 }, // 1st level
    { wch: 40 }, // 2nd level
    { wch: 40 }, // 3rd level
    { wch: 40 }, // 4th level
    { wch: 40 }, // 5th level
    { wch: 40 }, // 6th level
    { wch: 40 }, // 7th level
    { wch: 60 }, // URL
    { wch: 30 }, // Notes
  ];
  XLSX.utils.book_append_sheet(workbook, sitemapUrlsSheet, "Sitemap URLs");

  // Generate Excel file buffer
  const excelBuffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });

  return excelBuffer;
}

/**
 * Get sitemap in requested format
 */
async function getSitemap(jobId, format = "json") {
  const pagesResult = await pool.query(
    "SELECT url, title, depth, parent_url, original_href FROM pages WHERE job_id = $1 ORDER BY depth, url",
    [jobId]
  );

  const jobResult = await pool.query(
    "SELECT domain FROM crawl_jobs WHERE id = $1",
    [jobId]
  );

  if (jobResult.rows.length === 0) {
    throw new Error("Job not found");
  }

  const baseUrl = jobResult.rows[0].domain.startsWith("http")
    ? jobResult.rows[0].domain
    : `https://${jobResult.rows[0].domain}`;

  const pages = pagesResult.rows.map((row) => ({
    url: row.url,
    title: row.title,
    depth: row.depth,
    parentUrl: row.parent_url,
    originalHref: row.original_href || null,
  }));

  switch (format.toLowerCase()) {
    case "xml":
      return {
        content: generateXMLSitemap(pages, baseUrl),
        contentType: "application/xml",
        filename: `sitemap-${jobId}.xml`,
      };
    case "excel":
      return {
        content: generateExcelSitemap(pages, baseUrl),
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `sitemap-${jobId}.xlsx`,
      };
    case "tree":
      return {
        content: generateTreeDiagram(pages, baseUrl),
        contentType: "text/plain",
        filename: `sitemap-${jobId}.txt`,
      };
    case "json":
    default:
      return {
        content: JSON.stringify(generateJSONSitemap(pages), null, 2),
        contentType: "application/json",
        filename: `sitemap-${jobId}.json`,
      };
  }
}

module.exports = {
  generateXMLSitemap,
  generateTreeDiagram,
  generateJSONSitemap,
  generateExcelSitemap,
  getSitemap,
};
