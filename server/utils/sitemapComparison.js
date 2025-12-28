/**
 * Compare old vs new sitemap and generate diff, redirect map, and risk flags
 */

/**
 * Compare old and new sitemap trees
 * @param {Object} oldSitemap - Original sitemap tree
 * @param {Object} newSitemap - AI-optimized sitemap tree
 * @param {Array} oldPages - Original page records
 * @returns {Object} Comparison result with changes, redirects, and risks
 */
function compareSitemaps(oldSitemap, newSitemap, oldPages = []) {
  const comparison = {
    comparison_summary: {
      pages_before: oldSitemap._meta?.total_pages || 0,
      pages_after: newSitemap._meta?.total_pages || 0,
      max_depth_before: oldSitemap._meta?.max_depth || 0,
      max_depth_after: newSitemap._meta?.max_depth || 0,
      root_sections_before: Object.keys(oldSitemap.tree?.['/']?.children || {}).length,
      root_sections_after: Object.keys(newSitemap.tree?.['/']?.children || {}).length
    },
    structural_changes: [],
    redirect_map: [],
    risk_flags: {
      high: [],
      medium: [],
      low: []
    }
  };

  // Build path maps
  const oldPaths = new Set();
  const newPaths = new Set();
  const pathMapping = new Map(); // old path -> new path

  // Extract all paths from old sitemap
  function extractPaths(tree, prefix = '/', pathSet) {
    if (tree.children) {
      for (const [path, node] of Object.entries(tree.children)) {
        pathSet.add(path);
        if (node.children) {
          extractPaths(node, path, pathSet);
        }
      }
    }
  }

  extractPaths(oldSitemap.tree?.['/'] || {}, '/', oldPaths);
  extractPaths(newSitemap.tree?.['/'] || {}, '/', newPaths);

  // Find moved paths
  for (const oldPath of oldPaths) {
    // Check if path exists in new structure
    if (!newPaths.has(oldPath)) {
      // Path was moved - try to find similar path
      const pathSegments = oldPath.split('/').filter(s => s);
      const lastSegment = pathSegments[pathSegments.length - 1];

      // Look for matching segment in new structure
      let foundNewPath = null;
      for (const newPath of newPaths) {
        if (newPath.includes(lastSegment) || newPath.endsWith(lastSegment)) {
          foundNewPath = newPath;
          break;
        }
      }

      if (foundNewPath) {
        pathMapping.set(oldPath, foundNewPath);
        comparison.structural_changes.push({
          type: 'reorganization',
          from: oldPath,
          to: foundNewPath,
          reason: 'Path reorganized for better hierarchy'
        });
      } else {
        // Path might be consolidated
        comparison.structural_changes.push({
          type: 'consolidation',
          from: oldPath,
          to: null,
          reason: 'Path consolidated into parent section'
        });
      }
    }
  }

  // Generate redirect map
  for (const [oldPath, newPath] of pathMapping.entries()) {
    if (newPath) {
      comparison.redirect_map.push({
        from: oldPath,
        to: newPath,
        status: 301,
        reason: 'Sitemap restructuring'
      });
    }
  }

  // Detect risk flags
  const depthReduction = comparison.comparison_summary.max_depth_before - 
                         comparison.comparison_summary.max_depth_after;
  
  if (depthReduction > 2) {
    comparison.risk_flags.high.push(
      `Major depth reduction (${comparison.comparison_summary.max_depth_before} → ${comparison.comparison_summary.max_depth_after}). Verify all redirects are in place.`
    );
  }

  const rootSectionChange = comparison.comparison_summary.root_sections_before - 
                           comparison.comparison_summary.root_sections_after;
  
  if (Math.abs(rootSectionChange) > 5) {
    comparison.risk_flags.medium.push(
      `Significant root section change (${comparison.comparison_summary.root_sections_before} → ${comparison.comparison_summary.root_sections_after} sections). Review homepage structure.`
    );
  }

  if (comparison.redirect_map.length > 50) {
    comparison.risk_flags.medium.push(
      `Large number of redirects (${comparison.redirect_map.length}). Ensure server can handle redirect load.`
    );
  }

  if (comparison.structural_changes.length > 0) {
    const consolidationCount = comparison.structural_changes.filter(c => c.type === 'consolidation').length;
    if (consolidationCount > 0) {
      comparison.risk_flags.low.push(
        `${consolidationCount} paths consolidated. Update internal links and breadcrumbs.`
      );
    }
  }

  // Check for pages that might lose SEO value
  const movedPaths = comparison.structural_changes.filter(c => c.type === 'reorganization');
  if (movedPaths.length > 20) {
    comparison.risk_flags.medium.push(
      `${movedPaths.length} paths reorganized. Monitor search rankings after deployment.`
    );
  }

  return comparison;
}

/**
 * Generate redirect rules in common formats
 * @param {Array} redirectMap - Array of redirect objects
 * @param {String} format - 'nginx', 'apache', 'json'
 * @returns {String} Formatted redirect rules
 */
function generateRedirectRules(redirectMap, format = 'json') {
  switch (format.toLowerCase()) {
    case 'nginx':
      return redirectMap.map(r => 
        `rewrite ^${r.from.replace(/\//g, '\\/')}$ ${r.to} permanent;`
      ).join('\n');

    case 'apache':
      return redirectMap.map(r => 
        `Redirect 301 ${r.from} ${r.to}`
      ).join('\n');

    case 'json':
    default:
      return JSON.stringify(redirectMap, null, 2);
  }
}

module.exports = {
  compareSitemaps,
  generateRedirectRules
};

