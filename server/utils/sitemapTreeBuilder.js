/**
 * Build canonical sitemap tree from page records
 * This is the source of truth for AI processing
 */

/**
 * Convert flat page records to canonical sitemap tree
 * @param {Array} pages - Array of page objects with url, depth, parentUrl, title, pageData
 * @returns {Object} Canonical sitemap tree structure
 */
function buildCanonicalSitemapTree(pages) {
  if (!pages || pages.length === 0) {
    return {
      _meta: {
        total_pages: 0,
        max_depth: 0
      },
      tree: {
        '/': {
          _count: 0,
          children: {}
        }
      }
    };
  }

  // Calculate metadata
  const maxDepth = Math.max(...pages.map(p => p.depth || 0), 0);
  const totalPages = pages.length;

  // Build path-based tree
  const tree = {
    '/': {
      _count: 0,
      indexable: true,
      children: {}
    }
  };

  // Helper to get normalized path
  function getNormalizedPath(url) {
    try {
      const urlObj = new URL(url);
      let path = urlObj.pathname;
      // Preserve hash routes
      if (urlObj.hash && urlObj.hash.startsWith('#/')) {
        path = path + urlObj.hash;
      }
      return path || '/';
    } catch {
      return url;
    }
  }

  // Build path segments
  const pathMap = new Map(); // path -> node data
  const pageMap = new Map(); // url -> page data

  // First pass: create all nodes
  for (const page of pages) {
    const path = getNormalizedPath(page.url);
    pageMap.set(page.url, page);

    // Determine indexability
    const robots = page.pageData?.meta?.robots || 'index,follow';
    const isIndexable = !robots.includes('noindex');

    // Get canonical path if available
    let canonicalPath = path;
    if (page.pageData?.meta?.canonical) {
      try {
        const canonicalUrl = new URL(page.pageData.meta.canonical);
        canonicalPath = getNormalizedPath(canonicalUrl.href);
      } catch {
        // Use original path
      }
    }

    pathMap.set(path, {
      path: canonicalPath,
      indexable: isIndexable,
      page: page,
      depth: page.depth || 0
    });
  }

  // Second pass: build tree structure
  function addToTree(path, nodeData) {
    const segments = path.split('/').filter(s => s && s !== '#');
    
    // Handle root
    if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
      tree['/']._count++;
      return;
    }

    // Handle hash routes (SPA)
    let currentPath = '/';
    let currentNode = tree['/'];
    const pathParts = [];

    // Process path segments
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      
      // Skip hash marker
      if (segment === '#') continue;
      
      pathParts.push(segment);
      const segmentPath = '/' + pathParts.join('/');

      if (!currentNode.children[segmentPath]) {
        currentNode.children[segmentPath] = {
          _count: 0,
          indexable: true,
          children: {}
        };
      }

      currentNode = currentNode.children[segmentPath];
      currentPath = segmentPath;
    }

    // Add this page to the node
    currentNode._count++;
    if (!currentNode.indexable && nodeData.indexable) {
      currentNode.indexable = nodeData.indexable;
    } else if (nodeData.indexable === false) {
      currentNode.indexable = false;
    }

    // Update parent counts
    updateParentCounts(tree['/'], currentPath);
  }

  // Add all pages to tree
  for (const [path, nodeData] of pathMap.entries()) {
    addToTree(path, nodeData);
  }

  // Update all parent counts recursively
  function updateParentCounts(node, targetPath) {
    for (const [childPath, childNode] of Object.entries(node.children)) {
      if (targetPath.startsWith(childPath)) {
        // This is a parent, update its count
        let descendantCount = 0;
        function countDescendants(n) {
          descendantCount += n._count || 0;
          for (const c of Object.values(n.children || {})) {
            countDescendants(c);
          }
        }
        countDescendants(childNode);
        childNode._count = descendantCount;
      }
      // Recurse
      updateParentCounts(childNode, targetPath);
    }
  }

  // Final pass: ensure all parent counts are correct
  function recalculateCounts(node) {
    let total = 0;
    for (const child of Object.values(node.children || {})) {
      recalculateCounts(child);
      total += child._count || 0;
    }
    // If this node has direct pages (not just children), add them
    // For now, _count represents all descendants
    node._count = total || node._count || 0;
  }
  recalculateCounts(tree['/']);

  return {
    _meta: {
      total_pages: totalPages,
      max_depth: maxDepth
    },
    tree: tree
  };
}

/**
 * Convert tree sitemap to flat page records format (for backward compatibility)
 * @param {Object} tree - Canonical sitemap tree
 * @returns {Array} Array of page objects
 */
function treeToPages(tree) {
  const pages = [];
  
  function traverse(node, path = '/', depth = 0) {
    // Add current node if it represents a page
    if (node._count > 0 || Object.keys(node.children || {}).length === 0) {
      pages.push({
        path: path,
        depth: depth,
        count: node._count || 0,
        indexable: node.indexable !== false
      });
    }

    // Traverse children
    for (const [childPath, childNode] of Object.entries(node.children || {})) {
      traverse(childNode, childPath, depth + 1);
    }
  }

  if (tree.tree && tree.tree['/']) {
    traverse(tree.tree['/'], '/', 0);
  }

  return pages;
}

module.exports = {
  buildCanonicalSitemapTree,
  treeToPages
};

