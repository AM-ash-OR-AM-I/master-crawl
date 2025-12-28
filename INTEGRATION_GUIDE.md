# Production-Grade Sitemap Improvement System - Integration Guide

This guide shows how to use the new production-grade sitemap improvement features.

## Architecture Overview

```
Crawl → Enhanced Page Data → Canonical Tree → Issue Detection → AI Restructuring → Comparison → Output
```

## 1. Enhanced Crawler Data Collection

The crawler now collects comprehensive page data:

```javascript
const { crawlWebsite } = require('./server/crawler/playwrightCrawler');

const pages = await crawlWebsite({
  jobId: '...',
  domain: 'https://example.com',
  maxDepth: 3,
  maxPages: 500
});

// Each page now includes:
// - pageData.meta (description, robots, canonical, ogTitle)
// - pageData.content_signals (h1, h2_count, word_count)
// - pageData.links (all internal/external links)
// - pageData.tech (is_spa, route_type, framework_hint)
// - pageData.classification (intent, page_type)
```

## 2. Build Canonical Sitemap Tree

Convert flat pages to canonical tree structure:

```javascript
const { buildCanonicalSitemapTree } = require('./server/utils/sitemapTreeBuilder');

const canonicalTree = buildCanonicalSitemapTree(pages);

// Result structure:
// {
//   _meta: { total_pages: 311, max_depth: 4 },
//   tree: {
//     '/': {
//       _count: 311,
//       indexable: true,
//       children: {
//         '/learn': { _count: 142, children: {...} },
//         '/blog': { _count: 98, children: {...} }
//       }
//     }
//   }
// }
```

## 3. Detect Structural Issues

Before AI processing, detect issues programmatically:

```javascript
const { detectStructuralIssues } = require('./server/utils/issueDetector');

const issues = detectStructuralIssues(canonicalTree, pages);

// Returns:
// {
//   depth: { too_deep: [...], max_depth: 4 },
//   duplication: { numeric_slugs: [...], auto_generated: [...] },
//   crawl_waste: { faceted: [...], orphaned: [...] },
//   hierarchy: { flat_sections: [...], overloaded_root: true },
//   seo: { noindex_pages: [...], thin_content: [...] }
// }
```

## 4. AI Sitemap Improvement

Generate improved sitemap with production-grade prompts:

```javascript
const { generateImprovedSitemap } = require('./server/ai/aiProcessor');

const siteContext = {
  siteType: 'mixed', // 'blog' | 'docs' | 'ecommerce' | 'mixed'
  contentIntent: 'informational', // 'informational' | 'transactional' | 'hybrid'
  seoGoal: 'reduce crawl waste, create topic hubs',
  maxDepth: 3
};

const { improvedSitemap, prompt, error } = await generateImprovedSitemap(
  canonicalTree,
  issues,
  siteContext
);

// Returns:
// {
//   new_sitemap: { tree structure },
//   redirect_map: [
//     { from: '/old', to: '/new', status: 301, reason: '...' }
//   ],
//   indexing_rules: [
//     { path: '/account', action: 'noindex', reason: '...' }
//   ],
//   rationale: 'Brief explanation'
// }
```

## 5. Compare Old vs New

Generate comparison, redirect map, and risk flags:

```javascript
const { compareSitemaps, generateRedirectRules } = require('./server/utils/sitemapComparison');

const comparison = compareSitemaps(canonicalTree, improvedSitemap.new_sitemap, pages);

// Returns:
// {
//   comparison_summary: {
//     pages_before: 311,
//     pages_after: 311,
//     max_depth_before: 4,
//     max_depth_after: 3,
//     root_sections_before: 14,
//     root_sections_after: 6
//   },
//   structural_changes: [...],
//   redirect_map: [...],
//   risk_flags: {
//     high: [...],
//     medium: [...],
//     low: [...]
//   }
// }

// Generate redirect rules
const nginxRules = generateRedirectRules(comparison.redirect_map, 'nginx');
const apacheRules = generateRedirectRules(comparison.redirect_map, 'apache');
const jsonRules = generateRedirectRules(comparison.redirect_map, 'json');
```

## Complete Workflow Example

```javascript
const { crawlWebsite } = require('./server/crawler/playwrightCrawler');
const { buildCanonicalSitemapTree } = require('./server/utils/sitemapTreeBuilder');
const { detectStructuralIssues } = require('./server/utils/issueDetector');
const { generateImprovedSitemap } = require('./server/ai/aiProcessor');
const { compareSitemaps, generateRedirectRules } = require('./server/utils/sitemapComparison');

async function improveSitemap(jobId, domain) {
  // 1. Crawl
  const pages = await crawlWebsite({ jobId, domain, maxDepth: 3, maxPages: 500 });
  
  // 2. Build canonical tree
  const canonicalTree = buildCanonicalSitemapTree(pages);
  
  // 3. Detect issues
  const issues = detectStructuralIssues(canonicalTree, pages);
  console.log('Issues detected:', issues);
  
  // 4. Generate improved sitemap
  const { improvedSitemap } = await generateImprovedSitemap(
    canonicalTree,
    issues,
    {
      siteType: 'mixed',
      contentIntent: 'informational',
      seoGoal: 'reduce crawl waste, create topic hubs',
      maxDepth: 3
    }
  );
  
  // 5. Compare
  const comparison = compareSitemaps(
    canonicalTree,
    improvedSitemap.new_sitemap,
    pages
  );
  
  // 6. Generate outputs
  const redirectRules = generateRedirectRules(comparison.redirect_map, 'nginx');
  
  return {
    original: canonicalTree,
    improved: improvedSitemap.new_sitemap,
    comparison,
    redirectRules,
    riskFlags: comparison.risk_flags
  };
}
```

## Key Features

### ✅ Production-Grade AI Prompts
- Constrained to prevent hallucination
- Enforces SEO best practices
- Returns structured, diff-able output

### ✅ Machine-Detected Issues
- Depth violations
- Duplication patterns
- Crawl waste identification
- Hierarchy problems
- SEO signals

### ✅ Comprehensive Comparison
- Before/after metrics
- Structural change tracking
- Redirect map generation
- Risk flagging

### ✅ Enhanced Data Collection
- Meta tags (robots, canonical, OG)
- Content signals (H1, H2, word count)
- Link analysis
- Tech detection (SPA, framework)
- Page classification

## Next Steps

1. **Update database schema** to store enhanced page metadata
2. **Add UI components** to visualize comparisons
3. **Implement redirect rule export** (nginx/apache configs)
4. **Add confidence scoring** for AI suggestions
5. **Create visual tree diff** component

## API Integration

The new functions are available in:
- `server/utils/sitemapTreeBuilder.js` - Tree building
- `server/utils/issueDetector.js` - Issue detection
- `server/utils/sitemapComparison.js` - Comparison & redirects
- `server/ai/aiProcessor.js` - AI processing (enhanced)

All functions are backward-compatible with existing code.

