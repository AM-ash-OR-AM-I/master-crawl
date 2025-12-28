/**
 * Detect structural issues in sitemap before AI processing
 * Machine-detected issues that inform AI recommendations
 */

/**
 * Detect structural issues in sitemap tree
 * @param {Object} sitemapTree - Canonical sitemap tree
 * @param {Array} pages - Original page records with full data
 * @returns {Object} Structured issues object
 */
function detectStructuralIssues(sitemapTree, pages) {
  const issues = {
    depth: {
      too_deep: [],
      max_depth: 0
    },
    duplication: {
      numeric_slugs: [],
      auto_generated: [],
      duplicate_titles: []
    },
    crawl_waste: {
      faceted: [],
      low_value: [],
      orphaned: []
    },
    hierarchy: {
      flat_sections: [],
      overloaded_root: false,
      root_sections_count: 0
    },
    seo: {
      noindex_pages: [],
      missing_canonicals: [],
      thin_content: []
    }
  };

  if (!sitemapTree || !sitemapTree.tree) {
    return issues;
  }

  const tree = sitemapTree.tree['/'];
  const maxDepth = sitemapTree._meta?.max_depth || 0;

  // Track paths and their depths
  const pathDepths = new Map();
  const titleMap = new Map();
  const pathToPage = new Map();

  // Build page map
  for (const page of pages || []) {
    try {
      const urlObj = new URL(page.url);
      const path = urlObj.pathname + (urlObj.hash?.startsWith('#/') ? urlObj.hash : '');
      pathToPage.set(path, page);
    } catch {
      // Skip invalid URLs
    }
  }

  // Traverse tree to detect issues
  function traverse(node, path = '/', depth = 0) {
    // Check depth
    if (depth > 3) {
      issues.depth.too_deep.push(path);
    }
    issues.depth.max_depth = Math.max(issues.depth.max_depth, depth);

    // Check for numeric slugs
    const segments = path.split('/').filter(s => s);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && /^\d+$/.test(lastSegment)) {
      issues.duplication.numeric_slugs.push(path);
    }

    // Check for auto-generated patterns
    if (lastSegment && (
      /^[a-z]+_\d+$/i.test(lastSegment) || // plus_1, tag_2
      /^[a-z]+\d+$/i.test(lastSegment) ||  // page1, item2
      /^[a-z]+-\d+$/i.test(lastSegment)    // page-1, item-2
    )) {
      issues.duplication.auto_generated.push(path);
    }

    // Check page data if available
    const page = pathToPage.get(path);
    if (page) {
      // Check for duplicate titles
      const title = page.title || '';
      if (title && title !== 'Untitled' && title !== 'Page') {
        if (titleMap.has(title)) {
          issues.duplication.duplicate_titles.push({
            path: path,
            title: title,
            duplicate_of: titleMap.get(title)
          });
        } else {
          titleMap.set(title, path);
        }
      }

      // Check for faceted URLs
      try {
        const urlObj = new URL(page.url);
        if (urlObj.search && urlObj.search.length > 0) {
          issues.crawl_waste.faceted.push(path);
        }
      } catch {
        // Skip
      }

      // Check for thin content
      const wordCount = page.pageData?.content_signals?.word_count || 0;
      if (wordCount > 0 && wordCount < 300) {
        issues.seo.thin_content.push({
          path: path,
          word_count: wordCount
        });
      }

      // Check indexability
      const robots = page.pageData?.meta?.robots || 'index,follow';
      if (robots.includes('noindex')) {
        issues.seo.noindex_pages.push(path);
      }

      // Check for missing canonicals
      if (!page.pageData?.meta?.canonical) {
        issues.seo.missing_canonicals.push(path);
      }
    }

    // Traverse children
    for (const [childPath, childNode] of Object.entries(node.children || {})) {
      traverse(childNode, childPath, depth + 1);
    }
  }

  traverse(tree, '/', 0);

  // Check hierarchy issues
  const rootChildren = Object.keys(tree.children || {});
  issues.hierarchy.root_sections_count = rootChildren.length;
  issues.hierarchy.overloaded_root = rootChildren.length > 10;

  // Find flat sections (sections with many direct children but no sub-structure)
  for (const [sectionPath, sectionNode] of Object.entries(tree.children || {})) {
    const directChildren = Object.keys(sectionNode.children || {}).length;
    const totalCount = sectionNode._count || 0;
    
    // If section has many pages but shallow structure, it's flat
    if (totalCount > 20 && directChildren > 15) {
      // Check average depth
      let maxChildDepth = 0;
      function getMaxDepth(n, d = 0) {
        maxChildDepth = Math.max(maxChildDepth, d);
        for (const child of Object.values(n.children || {})) {
          getMaxDepth(child, d + 1);
        }
      }
      getMaxDepth(sectionNode, 0);
      
      if (maxChildDepth <= 1) {
        issues.hierarchy.flat_sections.push(sectionPath);
      }
    }
  }

  // Find orphaned pages (pages with no internal inlinks)
  // This requires link analysis - simplified version
  const pagesWithInlinks = new Set();
  for (const page of pages || []) {
    const outlinks = page.pageData?.links || [];
    for (const link of outlinks) {
      try {
        const linkUrl = new URL(link);
        const linkPath = linkUrl.pathname + (linkUrl.hash?.startsWith('#/') ? linkUrl.hash : '');
        pagesWithInlinks.add(linkPath);
      } catch {
        // Skip invalid links
      }
    }
  }

  for (const page of pages || []) {
    try {
      const urlObj = new URL(page.url);
      const path = urlObj.pathname + (urlObj.hash?.startsWith('#/') ? urlObj.hash : '');
      if (path !== '/' && !pagesWithInlinks.has(path)) {
        issues.crawl_waste.orphaned.push(path);
      }
    } catch {
      // Skip
    }
  }

  return issues;
}

/**
 * Format issues for AI consumption
 * @param {Object} issues - Raw issues object
 * @returns {Object} Formatted issues summary
 */
function formatIssuesForAI(issues) {
  const summary = {
    critical: [],
    warnings: [],
    info: []
  };

  // Critical issues
  if (issues.depth.too_deep.length > 0) {
    summary.critical.push({
      type: 'depth',
      message: `${issues.depth.too_deep.length} paths exceed depth 3`,
      paths: issues.depth.too_deep.slice(0, 10) // Limit for token efficiency
    });
  }

  if (issues.duplication.numeric_slugs.length > 0) {
    summary.critical.push({
      type: 'duplication',
      message: `${issues.duplication.numeric_slugs.length} paths use numeric slugs`,
      paths: issues.duplication.numeric_slugs.slice(0, 10)
    });
  }

  if (issues.hierarchy.overloaded_root) {
    summary.critical.push({
      type: 'hierarchy',
      message: `Root has ${issues.hierarchy.root_sections_count} sections (should be < 10)`
    });
  }

  // Warnings
  if (issues.duplication.auto_generated.length > 0) {
    summary.warnings.push({
      type: 'duplication',
      message: `${issues.duplication.auto_generated.length} auto-generated paths detected`,
      count: issues.duplication.auto_generated.length
    });
  }

  if (issues.hierarchy.flat_sections.length > 0) {
    summary.warnings.push({
      type: 'hierarchy',
      message: `${issues.hierarchy.flat_sections.length} flat sections need grouping`,
      sections: issues.hierarchy.flat_sections
    });
  }

  if (issues.crawl_waste.faceted.length > 0) {
    summary.warnings.push({
      type: 'crawl_waste',
      message: `${issues.crawl_waste.faceted.length} faceted URLs detected`
    });
  }

  // Info
  if (issues.seo.thin_content.length > 0) {
    summary.info.push({
      type: 'seo',
      message: `${issues.seo.thin_content.length} pages with thin content (< 300 words)`
    });
  }

  if (issues.crawl_waste.orphaned.length > 0) {
    summary.info.push({
      type: 'crawl_waste',
      message: `${issues.crawl_waste.orphaned.length} orphaned pages (no internal links)`
    });
  }

  return summary;
}

module.exports = {
  detectStructuralIssues,
  formatIssuesForAI
};

