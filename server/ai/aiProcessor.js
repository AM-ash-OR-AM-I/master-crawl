const OpenAI = require('openai');
const { pool } = require('../db/init');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_OUTPUT_TOKENS = 8000; // Increased for full sitemap output
const MAX_TOKENS_PER_PROMPT = 120000; // Leave room for prompt template
const LARGE_SITEMAP_THRESHOLD = 400; // URLs threshold for switching to file-based output

/**
 * Count total URLs in a sitemap tree
 * Handles both canonical tree format and legacy tree format
 */
function countUrlsInSitemap(sitemapTree) {
  if (!sitemapTree) return 0;
  
  // If it's a canonical tree with metadata, use the accurate count
  if (sitemapTree._meta && typeof sitemapTree._meta.total_pages === 'number') {
    return sitemapTree._meta.total_pages;
  }
  
  // If it's a legacy tree format, traverse and count nodes with URLs
  let count = 0;
  const visited = new Set(); // Prevent double counting
  
  function traverse(node) {
    // Count nodes with URLs (skip empty root nodes)
    if (node.url && node.url !== '' && !visited.has(node.url)) {
      count++;
      visited.add(node.url);
    }
    
    // Traverse children (array format)
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverse);
    }
    // Traverse children (object format - canonical tree)
    else if (node.children && typeof node.children === 'object') {
      Object.values(node.children).forEach(traverse);
    }
  }
  
  // Handle canonical tree structure
  if (sitemapTree.tree) {
    traverse(sitemapTree.tree);
  } else {
    traverse(sitemapTree);
  }
  
  return count;
}

/**
 * Get the system prompt used for AI analysis (Production-grade)
 */
function getSystemPrompt() {
  return `You are a Senior Technical SEO Architect.

You redesign website sitemap architectures for:
- Crawl efficiency
- Logical hierarchy
- Clear content hubs
- SEO best practices

Rules:
- Do NOT invent new content
- Do NOT remove valid pages
- Only restructure paths and grouping
- Preserve all existing URLs via redirects
- Maximum depth allowed: 3
- Prefer semantic, human-readable paths
- Group related content into hubs
- Always respond with valid JSON only`;
}

/**
 * Get the full prompt template (system + user prompt)
 */
function getFullPrompt() {
  const systemPrompt = getSystemPrompt();
  
  const improvementPrompt = `INPUTS:
1. Current sitemap tree (JSON)
2. Detected structural issues (JSON)

SITE CONTEXT:
- Site type: mixed
- Content intent: informational
- SEO goal: reduce crawl waste, create topic hubs
- Maximum depth allowed: 3

TASKS:
1. Propose a NEW sitemap tree that addresses the structural issues
2. Ensure depth ≤ 3
3. Consolidate flat or fragmented sections into logical hubs
4. Return a redirect map (301) for all moved paths
5. List index/noindex recommendations
6. Explain structural changes briefly

OUTPUT FORMAT:
Return VALID JSON with keys:
- new_sitemap: { tree structure matching current format }
- redirect_map: [ { from: "/old", to: "/new", status: 301, reason: "..." } ]
- indexing_rules: [ { path: "/path", action: "noindex", reason: "..." } ]
- rationale: "Brief explanation of changes"

Remember: Do NOT invent new content. Only restructure existing paths.`;

  return {
    system: systemPrompt,
    improvement: improvementPrompt,
    full: `SYSTEM PROMPT:\n${systemPrompt}\n\n---\n\nIMPROVEMENT PROMPT:\n${improvementPrompt}`
  };
}

/**
 * Process sitemap with AI improvement (single prompt approach)
 * This function uses the canonical tree format and structural issues
 */
async function processSitemap(jobId, sitemap, canonicalTree = null, structuralIssues = null, siteContext = {}) {
  try {
    const systemPrompt = getSystemPrompt();
    
    // If canonical tree not provided, convert from legacy format
    let treeToUse = canonicalTree;
    if (!treeToUse && sitemap) {
      // Convert legacy tree format to canonical format
      const { buildCanonicalSitemapTree } = require('../utils/sitemapTreeBuilder');
      // Extract pages from legacy sitemap format
      const pages = extractPagesFromTree(sitemap);
      treeToUse = buildCanonicalSitemapTree(pages);
    }
    
    // Generate improved sitemap
    const { improvedSitemap, prompt, error } = await generateImprovedSitemap(
      treeToUse,
      structuralIssues,
      siteContext
    );
    
    if (error || !improvedSitemap) {
      throw new Error(error || 'Failed to generate improved sitemap');
    }
    
    // Extract recommendations from improved sitemap
    const recommendations = extractRecommendationsFromImproved(improvedSitemap);
    
    return {
      recommendations,
      improvedSitemap,
      prompt: {
        systemPrompt: systemPrompt,
        userPrompt: prompt,
        fullPrompt: `SYSTEM PROMPT:\n${systemPrompt}\n\n---\n\nUSER PROMPT:\n${prompt}`
      },
    };
  } catch (error) {
    console.error('AI processing error:', error);
    return {
      recommendations: [],
      improvedSitemap: null,
      prompt: null,
      error: error.message
    };
  }
}

/**
 * Extract pages from legacy tree format
 */
function extractPagesFromTree(tree) {
  const pages = [];
  
  function traverse(node, parentUrl = null, depth = 0) {
    if (node.url) {
      pages.push({
        url: node.url,
        title: node.title || 'Untitled',
        depth: depth,
        parentUrl: parentUrl
      });
    }
    
    if (node.children && Array.isArray(node.children)) {
      for (const child of node.children) {
        traverse(child, node.url || parentUrl, depth + 1);
      }
    }
  }
  
  traverse(tree);
  return pages;
}

/**
 * Extract recommendations from improved sitemap response
 */
function extractRecommendationsFromImproved(improvedSitemap) {
  const recommendations = [];
  
  // Extract from redirect_map
  if (improvedSitemap.redirect_map && Array.isArray(improvedSitemap.redirect_map)) {
    for (const redirect of improvedSitemap.redirect_map) {
      recommendations.push({
        category: 'URL_RESTRUCTURE',
        before: redirect.from,
        after: redirect.to,
        explanation: redirect.reason || 'Sitemap restructuring'
      });
    }
  }
  
  // Extract from indexing_rules
  if (improvedSitemap.indexing_rules && Array.isArray(improvedSitemap.indexing_rules)) {
    for (const rule of improvedSitemap.indexing_rules) {
      recommendations.push({
        category: 'INDEXING',
        before: rule.path,
        after: rule.action,
        explanation: rule.reason || 'SEO optimization'
      });
    }
  }
  
  return recommendations;
}


/**
 * Generate production-grade AI prompt for sitemap restructuring
 * This produces the new sitemap tree + redirect map
 */
async function generateImprovedSitemap(currentSitemapTree, structuralIssues, siteContext = {}) {
  const systemPrompt = getSystemPrompt();
  
  const siteType = siteContext.siteType || 'mixed';
  const contentIntent = siteContext.contentIntent || 'informational';
  const seoGoal = siteContext.seoGoal || 'reduce crawl waste, create topic hubs';
  const maxDepth = siteContext.maxDepth || 3;

  // Format issues for AI
  const issuesFormatted = structuralIssues ? {
    depth: {
      too_deep_count: structuralIssues.depth?.too_deep?.length || 0,
      max_depth: structuralIssues.depth?.max_depth || 0
    },
    duplication: {
      numeric_slugs: structuralIssues.duplication?.numeric_slugs?.slice(0, 10) || [],
      auto_generated: structuralIssues.duplication?.auto_generated?.slice(0, 10) || []
    },
    hierarchy: {
      overloaded_root: structuralIssues.hierarchy?.overloaded_root || false,
      flat_sections: structuralIssues.hierarchy?.flat_sections || []
    },
    crawl_waste: {
      faceted: structuralIssues.crawl_waste?.faceted?.slice(0, 10) || [],
      orphaned: structuralIssues.crawl_waste?.orphaned?.slice(0, 10) || []
    }
  } : {};

  // Always use file-based output format
  const userPrompt = `EXECUTION MODE: FILE-BASED OUTPUT (REQUIRED)

You MUST generate downloadable files to avoid truncation, partial output, or broken JSON.

INPUTS:
1. Current sitemap tree (JSON)
2. Page metadata (JSON)
3. Detected structural issues (JSON)

SITE CONTEXT:
- Site type: ${siteType}
- Content intent: ${contentIntent}
- SEO goal: ${seoGoal}
- Indexing constraints: account & filters must be noindex
- Maximum depth allowed: ${maxDepth}

TASKS:
1. Propose a NEW sitemap tree that addresses the structural issues
2. Ensure depth ≤ ${maxDepth}
3. Consolidate flat or fragmented sections into logical hubs
4. Return a redirect map (301) for all moved paths
5. List index/noindex recommendations
6. Explain structural changes briefly

CURRENT SITEMAP TREE:
${JSON.stringify(currentSitemapTree, null, 2)}

STRUCTURAL ISSUES:
${JSON.stringify(issuesFormatted, null, 2)}

📌 OUTPUT REQUIREMENTS (FILE-BASED):

You MUST provide the following as downloadable file contents or code blocks:

1. new_sitemap.json - FULLY EXPANDED new sitemap tree (all URLs restructured, no truncation, no placeholders)
2. new_sitemap.xlsx - Excel file with columns: URL, Title, Depth, Parent URL (provide as CSV format or structured data that can be converted to Excel)
3. redirect_map.json - Complete redirect mapping: [ { from: "/old", to: "/new", status: 301, reason: "..." } ]
4. indexing_rules.json - Indexing recommendations: [ { path: "/path", action: "noindex|index", reason: "..." } ]
5. rationale.json - Brief explanation: { "summary": "...", "key_changes": [...], "expected_impact": "..." }

CRITICAL VALIDATION RULES:
❌ If trees are summarized → RESPONSE IS INVALID
❌ If ANY input URL from CURRENT SITEMAP TREE is missing from new_sitemap → RESPONSE IS INVALID
❌ If redirect_map is incomplete → RESPONSE IS INVALID
❌ If JSON is truncated or broken → RESPONSE IS INVALID
❌ If branches are collapsed or placeholders used → RESPONSE IS INVALID

✅ CORRECT EXECUTION:
- Every URL from the CURRENT SITEMAP TREE input MUST appear in new_sitemap (possibly restructured)
- Every moved URL MUST have a redirect_map entry
- All JSON files must be complete, valid, and downloadable
- Use code blocks with language tags: \`\`\`json for each file
- Fully expand all tree branches - no collapsing, no placeholders
- Excel file must include all URLs with columns: URL, Title, Depth, Parent URL

ALTERNATIVE: If file generation is not possible, use CHUNKED RESPONSE mode:
- Response 1: Full new_sitemap.json (all URLs, fully expanded)
- Response 2: new_sitemap.xlsx data (CSV format or structured JSON with columns: URL, Title, Depth, Parent URL)
- Response 3: redirect_map.json + indexing_rules.json + rationale.json

Each chunk must be clearly labeled (e.g., "NEW_SITEMAP — Part 1/1", "EXCEL_DATA — Part 1/1").

Note: For Excel file, provide data in CSV format or as structured JSON array that can be easily converted to Excel with columns: URL, Title, Depth, Parent URL.

Remember: Do NOT invent new content. Only restructure existing paths.`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      max_tokens: MAX_OUTPUT_TOKENS * 2, // Allow more tokens for full sitemap
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
    
    const improvedSitemap = JSON.parse(jsonStr);
    return { improvedSitemap, prompt: userPrompt };
  } catch (error) {
    console.error('Generate improved sitemap error:', error);
    return { improvedSitemap: null, prompt: userPrompt, error: error.message };
  }
}




/**
 * Generate single prompt with sitemap data (without calling AI)
 * This generates the prompt that can be used manually in ChatGPT
 */
function generatePromptsWithData(sitemap, canonicalTree = null, structuralIssues = null, siteContext = {}) {
  try {
    const systemPrompt = getSystemPrompt();
    
    // If canonical tree not provided, try to build it
    let treeToUse = canonicalTree;
    if (!treeToUse && sitemap) {
      const { buildCanonicalSitemapTree } = require('../utils/sitemapTreeBuilder');
      const pages = extractPagesFromTree(sitemap);
      treeToUse = buildCanonicalSitemapTree(pages);
    }
    
    // Build the improvement prompt
    const siteType = siteContext.siteType || 'mixed';
    const contentIntent = siteContext.contentIntent || 'informational';
    const seoGoal = siteContext.seoGoal || 'reduce crawl waste, create topic hubs';
    const maxDepth = siteContext.maxDepth || 3;

    // Format issues for prompt
    const issuesFormatted = structuralIssues ? {
      depth: {
        too_deep_count: structuralIssues.depth?.too_deep?.length || 0,
        too_deep_examples: structuralIssues.depth?.too_deep?.slice(0, 5) || [],
        max_depth: structuralIssues.depth?.max_depth || 0
      },
      duplication: {
        numeric_slugs: structuralIssues.duplication?.numeric_slugs?.slice(0, 10) || [],
        auto_generated: structuralIssues.duplication?.auto_generated?.slice(0, 10) || []
      },
      hierarchy: {
        overloaded_root: structuralIssues.hierarchy?.overloaded_root || false,
        root_sections_count: structuralIssues.hierarchy?.root_sections_count || 0,
        flat_sections: structuralIssues.hierarchy?.flat_sections || []
      },
      crawl_waste: {
        faceted: structuralIssues.crawl_waste?.faceted?.slice(0, 10) || [],
        orphaned: structuralIssues.crawl_waste?.orphaned?.slice(0, 10) || []
      }
    } : {};

    // Always use file-based output format
    const userPrompt = `EXECUTION MODE: FILE-BASED OUTPUT (REQUIRED)

You MUST generate downloadable files to avoid truncation, partial output, or broken JSON.

INPUTS:
1. Current sitemap tree (JSON)
2. Detected structural issues (JSON)

SITE CONTEXT:
- Site type: ${siteType}
- Content intent: ${contentIntent}
- SEO goal: ${seoGoal}
- Indexing constraints: account & filters must be noindex
- Maximum depth allowed: ${maxDepth}

TASKS:
1. Propose a NEW sitemap tree that addresses the structural issues
2. Ensure depth ≤ ${maxDepth}
3. Consolidate flat or fragmented sections into logical hubs
4. Return a redirect map (301) for all moved paths
5. List index/noindex recommendations
6. Explain structural changes briefly

CURRENT SITEMAP TREE:
${JSON.stringify(treeToUse, null, 2)}

STRUCTURAL ISSUES:
${JSON.stringify(issuesFormatted, null, 2)}

📌 OUTPUT REQUIREMENTS (FILE-BASED):

You MUST provide the following as downloadable file contents or code blocks:

1. new_sitemap.json - FULLY EXPANDED new sitemap tree (all URLs restructured, no truncation, no placeholders)
2. new_sitemap.xlsx - Excel file with columns: URL, Title, Depth, Parent URL (provide as CSV format or structured data that can be converted to Excel)
3. redirect_map.json - Complete redirect mapping: [ { from: "/old", to: "/new", status: 301, reason: "..." } ]
4. indexing_rules.json - Indexing recommendations: [ { path: "/path", action: "noindex|index", reason: "..." } ]
5. rationale.json - Brief explanation: { "summary": "...", "key_changes": [...], "expected_impact": "..." }

CRITICAL VALIDATION RULES:
❌ If trees are summarized → RESPONSE IS INVALID
❌ If ANY input URL from CURRENT SITEMAP TREE is missing from new_sitemap → RESPONSE IS INVALID
❌ If redirect_map is incomplete → RESPONSE IS INVALID
❌ If JSON is truncated or broken → RESPONSE IS INVALID
❌ If branches are collapsed or placeholders used → RESPONSE IS INVALID

✅ CORRECT EXECUTION:
- Every URL from the CURRENT SITEMAP TREE input MUST appear in new_sitemap (possibly restructured)
- Every moved URL MUST have a redirect_map entry
- All JSON files must be complete, valid, and downloadable
- Use code blocks with language tags: \`\`\`json for each file
- Fully expand all tree branches - no collapsing, no placeholders
- Excel file must include all URLs with columns: URL, Title, Depth, Parent URL

ALTERNATIVE: If file generation is not possible, use CHUNKED RESPONSE mode:
- Response 1: Full new_sitemap.json (all URLs, fully expanded)
- Response 2: new_sitemap.xlsx data (CSV format or structured JSON with columns: URL, Title, Depth, Parent URL)
- Response 3: redirect_map.json + indexing_rules.json + rationale.json

Each chunk must be clearly labeled (e.g., "NEW_SITEMAP — Part 1/1", "EXCEL_DATA — Part 1/1").

Note: For Excel file, provide data in CSV format or as structured JSON array that can be easily converted to Excel with columns: URL, Title, Depth, Parent URL.

Remember: Do NOT invent new content. Only restructure existing paths.`;
    
    return {
      improvement: {
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        fullPrompt: `SYSTEM PROMPT:\n${systemPrompt}\n\n---\n\nUSER PROMPT:\n${userPrompt}`
      }
    };
  } catch (error) {
    console.error('Error generating prompts with data:', error);
    return {
      improvement: null
    };
  }
}

module.exports = { 
  processSitemap, 
  getSystemPrompt, 
  getFullPrompt, 
  generatePromptsWithData,
  generateImprovedSitemap,
  extractPagesFromTree,
  countUrlsInSitemap,
  LARGE_SITEMAP_THRESHOLD
};

