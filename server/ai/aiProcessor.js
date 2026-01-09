const OpenAI = require("openai");
const { pool } = require("../db/init");

// Configure OpenAI client - supports both Azure OpenAI and standard OpenAI
let openaiConfig = {};

if (process.env.AZURE_OPENAI_ENDPOINT) {
  // Azure OpenAI configuration
  const azureApiKey =
    process.env.AZURE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  let azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, ""); // Remove trailing slash
  const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT;

  if (!deploymentName) {
    throw new Error(
      "AZURE_OPENAI_DEPLOYMENT is required when using Azure OpenAI"
    );
  }

  // Ensure endpoint is just the base URL (remove any trailing paths)
  // Azure endpoint should be: https://{resource-name}.openai.azure.com
  if (azureEndpoint.includes("/openai")) {
    azureEndpoint = azureEndpoint.split("/openai")[0];
  }

  // For Azure OpenAI with OpenAI SDK v4+, the baseURL should be the base endpoint
  // The SDK will append paths, but Azure needs: /openai/deployments/{deployment}/chat/completions
  // So we set baseURL to include the deployment path
  // Format: https://{resource-name}.openai.azure.com/openai/deployments/{deployment-name}
  const azureBaseURL = `${azureEndpoint}/openai/deployments/${deploymentName}`;

  openaiConfig = {
    apiKey: azureApiKey,
    baseURL: azureBaseURL,
    defaultQuery: {
      "api-version":
        process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview",
    },
    defaultHeaders: {
      "api-key": azureApiKey,
    },
  };
  console.log("Using Azure OpenAI API");
  console.log(`Azure OpenAI Endpoint: ${azureEndpoint}`);
  console.log(`Azure OpenAI Deployment: ${deploymentName}`);
  console.log(
    `Azure OpenAI API Version: ${
      process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview"
    }`
  );
  console.log(`Full baseURL: ${openaiConfig.baseURL}`);
  console.log(
    `Expected request URL: ${openaiConfig.baseURL}/chat/completions?api-version=${openaiConfig.defaultQuery["api-version"]}`
  );

  // Validate configuration
  if (!azureApiKey) {
    throw new Error(
      "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY or OPENAI_API_KEY"
    );
  }
  if (!azureEndpoint || !azureEndpoint.startsWith("https://")) {
    throw new Error(
      `Invalid Azure OpenAI endpoint: ${azureEndpoint}. Should be https://{resource-name}.openai.azure.com`
    );
  }
} else {
  // Standard OpenAI configuration
  openaiConfig = {
    apiKey: process.env.OPENAI_API_KEY,
  };
  console.log("Using standard OpenAI API");
}

const openai = new OpenAI(openaiConfig);

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
  if (sitemapTree._meta && typeof sitemapTree._meta.total_pages === "number") {
    return sitemapTree._meta.total_pages;
  }

  // If it's a legacy tree format, traverse and count nodes with URLs
  let count = 0;
  const visited = new Set(); // Prevent double counting

  function traverse(node) {
    // Count nodes with URLs (skip empty root nodes)
    if (node.url && node.url !== "" && !visited.has(node.url)) {
      count++;
      visited.add(node.url);
    }

    // Traverse children (array format)
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverse);
    }
    // Traverse children (object format - canonical tree)
    else if (node.children && typeof node.children === "object") {
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
    full: `SYSTEM PROMPT:\n${systemPrompt}\n\n---\n\nIMPROVEMENT PROMPT:\n${improvementPrompt}`,
  };
}

/**
 * Process sitemap with AI improvement (single prompt approach)
 * This function uses the canonical tree format and structural issues
 * Now uses the same format as exported JSON (flat pages array from database)
 */
async function processSitemap(
  jobId,
  sitemap,
  canonicalTree = null,
  structuralIssues = null,
  siteContext = {}
) {
  try {
    const systemPrompt = getSystemPrompt();

    // Fetch pages directly from database (same as exported JSON format)
    // This ensures consistency with the exported JSON format
    let treeToUse = canonicalTree;
    if (!treeToUse) {
      const {
        buildCanonicalSitemapTree,
      } = require("../utils/sitemapTreeBuilder");

      // Fetch pages from database in the same format as exported JSON
      // This ensures we use the exact same data source as the exported JSON
      const pagesResult = await pool.query(
        "SELECT url, title, depth, parent_url, original_href FROM pages WHERE job_id = $1 ORDER BY depth, COALESCE(sequence, 999999), crawled_at",
        [jobId]
      );

      const pages = pagesResult.rows.map((row) => ({
        url: row.url,
        title: row.title || "Untitled",
        depth: row.depth || 0,
        parentUrl: row.parent_url || null,
        originalHref: row.original_href || null,
      }));

      // Build canonical tree from pages (same format as exported JSON)
      treeToUse = buildCanonicalSitemapTree(pages);
    }

    // Generate improved sitemap
    const { improvedSitemap, prompt, error } = await generateImprovedSitemap(
      treeToUse,
      structuralIssues,
      siteContext
    );

    if (error || !improvedSitemap) {
      throw new Error(error || "Failed to generate improved sitemap");
    }

    // Extract recommendations from improved sitemap
    const recommendations = extractRecommendationsFromImproved(improvedSitemap);
    console.log(
      `processSitemap: extracted ${recommendations.length} recommendations`
    );

    return {
      recommendations,
      improvedSitemap,
      prompt: {
        systemPrompt: systemPrompt,
        userPrompt: prompt,
        fullPrompt: `SYSTEM PROMPT:\n${systemPrompt}\n\n---\n\nUSER PROMPT:\n${prompt}`,
      },
    };
  } catch (error) {
    console.error("AI processing error:", error);
    return {
      recommendations: [],
      improvedSitemap: null,
      prompt: null,
      error: error.message,
    };
  }
}

/**
 * Extract pages from tree format (JSON viewer format) or exported JSON format
 * Returns pages in the same format as exported JSON (flat array)
 */
function extractPagesFromTree(tree) {
  const pages = [];

  // Check if this is the exported JSON format (has 'pages' array)
  if (tree && tree.pages && Array.isArray(tree.pages)) {
    // This is the exported JSON format - return pages directly
    return tree.pages.map((page) => ({
      url: page.url,
      title: page.title || "Untitled",
      depth: page.depth || 0,
      parentUrl: page.parentUrl || null,
      originalHref: page.originalHref || null,
    }));
  }

  // Otherwise, it's the tree format (JSON viewer format) - traverse it
  function traverse(node, parentUrl = null, depth = 0) {
    if (node.url) {
      pages.push({
        url: node.url,
        title: node.title || "Untitled",
        depth: depth,
        parentUrl: parentUrl,
        originalHref: node.originalHref || null,
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

  if (!improvedSitemap) {
    console.log(
      "extractRecommendationsFromImproved: improvedSitemap is null or undefined"
    );
    return recommendations;
  }

  console.log(
    "extractRecommendationsFromImproved: improvedSitemap keys:",
    Object.keys(improvedSitemap)
  );

  // Extract from redirect_map
  if (
    improvedSitemap.redirect_map &&
    Array.isArray(improvedSitemap.redirect_map)
  ) {
    console.log(
      `Found ${improvedSitemap.redirect_map.length} redirect_map entries`
    );
    for (const redirect of improvedSitemap.redirect_map) {
      recommendations.push({
        category: "URL_RESTRUCTURE",
        before: redirect.from,
        after: redirect.to,
        explanation: redirect.reason || "Sitemap restructuring",
      });
    }
  } else {
    console.log("No redirect_map found or not an array");
  }

  // Extract from indexing_rules
  if (
    improvedSitemap.indexing_rules &&
    Array.isArray(improvedSitemap.indexing_rules)
  ) {
    console.log(
      `Found ${improvedSitemap.indexing_rules.length} indexing_rules entries`
    );
    for (const rule of improvedSitemap.indexing_rules) {
      recommendations.push({
        category: "INDEXING",
        before: rule.path,
        after: rule.action,
        explanation: rule.reason || "SEO optimization",
      });
    }
  } else {
    console.log("No indexing_rules found or not an array");
  }

  console.log(
    `extractRecommendationsFromImproved: extracted ${recommendations.length} recommendations`
  );
  return recommendations;
}

/**
 * Generate production-grade AI prompt for sitemap restructuring
 * This produces the new sitemap tree + redirect map
 */
async function generateImprovedSitemap(
  currentSitemapTree,
  structuralIssues,
  siteContext = {}
) {
  const systemPrompt = getSystemPrompt();

  const siteType = siteContext.siteType || "mixed";
  const contentIntent = siteContext.contentIntent || "informational";
  const seoGoal =
    siteContext.seoGoal || "reduce crawl waste, create topic hubs";
  const maxDepth = siteContext.maxDepth || 3;

  // Format issues for AI
  const issuesFormatted = structuralIssues
    ? {
        depth: {
          too_deep_count: structuralIssues.depth?.too_deep?.length || 0,
          max_depth: structuralIssues.depth?.max_depth || 0,
        },
        duplication: {
          numeric_slugs:
            structuralIssues.duplication?.numeric_slugs?.slice(0, 10) || [],
          auto_generated:
            structuralIssues.duplication?.auto_generated?.slice(0, 10) || [],
        },
        hierarchy: {
          overloaded_root: structuralIssues.hierarchy?.overloaded_root || false,
          flat_sections: structuralIssues.hierarchy?.flat_sections || [],
        },
        crawl_waste: {
          faceted: structuralIssues.crawl_waste?.faceted?.slice(0, 10) || [],
          orphaned: structuralIssues.crawl_waste?.orphaned?.slice(0, 10) || [],
        },
      }
    : {};

  // Request JSON format with expected structure for recommendations
  const userPrompt = `You are analyzing a website sitemap to provide SEO recommendations.

INPUTS:
1. Current sitemap tree (JSON) - Note: If analyzing from exported JSON, check the \`issues.brokenLinks\` section for broken links that need fixes
2. Detected structural issues (JSON)

SITE CONTEXT:
- Site type: ${siteType}
- Content intent: ${contentIntent}
- SEO goal: ${seoGoal}
- Indexing constraints: account & filters must be noindex
- Maximum depth allowed: ${maxDepth}

CURRENT SITEMAP TREE:
${JSON.stringify(currentSitemapTree, null, 2)}

STRUCTURAL ISSUES:
${JSON.stringify(issuesFormatted, null, 2)}

TASKS:
1. Analyze the current sitemap structure
2. If the sitemap data includes an \`issues.brokenLinks\` section:
   - Review each broken link's errorType and recommendation
   - For 404 errors with "Redirect or Remove": suggest redirects to appropriate pages or mark for removal in redirect_map
   - For other error types: suggest investigation actions
   - Include broken link fixes in your redirect_map recommendations
3. Identify URLs that should be redirected (301) to better paths
4. Identify paths that should be set to noindex
5. Provide recommendations for restructuring

OUTPUT FORMAT:
You MUST respond with ONLY valid JSON in the following format:

\`\`\`json
{
  "redirect_map": [
    {
      "from": "/old/path",
      "to": "/new/path",
      "status": 301,
      "reason": "Brief explanation of why this redirect is needed"
    }
  ],
  "indexing_rules": [
    {
      "path": "/path/to/noindex",
      "action": "noindex",
      "reason": "Brief explanation of why this should be noindexed"
    }
  ],
  "rationale": "Brief overall explanation of the recommendations"
}
\`\`\`

CRITICAL REQUIREMENTS:
- Respond with ONLY the JSON object, wrapped in \`\`\`json code blocks
- Include redirect_map array with all recommended redirects
  - MUST include redirects for broken links from \`issues.brokenLinks\` section (especially 404 errors)
  - Use the \`recommendation\` field from broken links to determine action (redirect or remove)
- Include indexing_rules array with all recommended noindex rules
- Each redirect must have: from, to, status (301), and reason
  - For broken links: reason should reference the errorType (e.g., "404 Not Found - redirecting to parent page")
- Each indexing rule must have: path, action ("noindex"), and reason
- Do NOT invent new content - only recommend changes to existing URLs
- Focus on addressing the structural issues provided AND broken links from the \`issues.brokenLinks\` section

Remember: Do NOT invent new content. Only restructure existing paths.`;

  try {
    // For Azure OpenAI, the model parameter should be the deployment name
    // For standard OpenAI, use the model name from env or default
    // Note: For Azure, the deployment is already in the baseURL, so we can use any value
    // but Azure requires the model parameter to match the deployment name
    const modelName = process.env.AZURE_OPENAI_ENDPOINT
      ? process.env.AZURE_OPENAI_DEPLOYMENT
      : process.env.OPENAI_MODEL || "gpt-4-turbo-preview";

    if (!modelName) {
      throw new Error(
        "Model name is required. Set AZURE_OPENAI_DEPLOYMENT for Azure or OPENAI_MODEL for standard OpenAI"
      );
    }

    console.log("Using model:", modelName);
    if (process.env.AZURE_OPENAI_ENDPOINT) {
      console.log("Azure OpenAI baseURL:", openaiConfig.baseURL);
      console.log("Request will be made to Azure OpenAI endpoint");
    }

    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      max_completion_tokens: MAX_OUTPUT_TOKENS * 2, // Allow more tokens for full sitemap
    });

    const content = response.choices[0].message.content;
    console.log("AI response content length:", content.length);
    console.log("AI response preview:", content.substring(0, 500));

    // Try multiple patterns to extract JSON
    let jsonStr = null;

    // First try: JSON code block
    const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1].trim();
    } else {
      // Second try: Any code block
      const codeBlockMatch = content.match(/```\s*([\s\S]*?)\s*```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
        // Remove language identifier if present
        jsonStr = jsonStr.replace(/^[a-z]+\n/, "");
      } else {
        // Third try: Find JSON object in content
        const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
        if (jsonObjectMatch) {
          jsonStr = jsonObjectMatch[0];
        } else {
          jsonStr = content.trim();
        }
      }
    }

    let improvedSitemap;
    try {
      improvedSitemap = JSON.parse(jsonStr);
      console.log(
        "Parsed improved sitemap keys:",
        Object.keys(improvedSitemap || {})
      );
      console.log("Has redirect_map:", !!improvedSitemap?.redirect_map);
      console.log("Has indexing_rules:", !!improvedSitemap?.indexing_rules);

      // Validate structure
      if (!improvedSitemap.redirect_map && !improvedSitemap.indexing_rules) {
        console.warn(
          "Warning: Response does not contain redirect_map or indexing_rules"
        );
      }
    } catch (parseError) {
      console.error("JSON parse error:", parseError.message);
      console.error("Attempted to parse:", jsonStr.substring(0, 500));
      throw new Error(
        `Failed to parse AI response as JSON: ${parseError.message}`
      );
    }

    return { improvedSitemap, prompt: userPrompt };
  } catch (error) {
    console.error("Generate improved sitemap error:", error);
    if (error.status) {
      console.error(`HTTP Status: ${error.status}`);
    }
    if (error.code) {
      console.error(`Error Code: ${error.code}`);
    }
    if (error.error) {
      console.error(`Error Details:`, JSON.stringify(error.error, null, 2));
    }
    if (process.env.AZURE_OPENAI_ENDPOINT) {
      console.error(
        `Azure OpenAI Configuration Check:
        - Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}
        - Deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}
        - API Version: ${
          process.env.AZURE_OPENAI_API_VERSION || "2024-02-15-preview"
        }
        - BaseURL: ${openaiConfig.baseURL}
        Please verify:
        1. The deployment name matches exactly (case-sensitive)
        2. The endpoint URL is correct: https://{resource-name}.openai.azure.com
        3. The API key has access to this deployment
        4. The deployment exists and is active in Azure Portal`
      );
    }
    return { improvedSitemap: null, prompt: userPrompt, error: error.message };
  }
}

/**
 * Generate single prompt with sitemap data (without calling AI)
 * This generates the prompt that can be used manually in Grok
 */
function generatePromptsWithData(
  sitemap,
  canonicalTree = null,
  structuralIssues = null,
  siteContext = {}
) {
  try {
    const systemPrompt = getSystemPrompt();

    // If canonical tree not provided, try to build it
    let treeToUse = canonicalTree;
    if (!treeToUse && sitemap) {
      const {
        buildCanonicalSitemapTree,
      } = require("../utils/sitemapTreeBuilder");
      const pages = extractPagesFromTree(sitemap);
      treeToUse = buildCanonicalSitemapTree(pages);
    }

    // Build the improvement prompt
    const siteType = siteContext.siteType || "mixed";
    const contentIntent = siteContext.contentIntent || "informational";
    const seoGoal =
      siteContext.seoGoal || "reduce crawl waste, create topic hubs";
    const maxDepth = siteContext.maxDepth || 3;

    // Format issues for prompt
    const issuesFormatted = structuralIssues
      ? {
          depth: {
            too_deep_count: structuralIssues.depth?.too_deep?.length || 0,
            too_deep_examples:
              structuralIssues.depth?.too_deep?.slice(0, 5) || [],
            max_depth: structuralIssues.depth?.max_depth || 0,
          },
          duplication: {
            numeric_slugs:
              structuralIssues.duplication?.numeric_slugs?.slice(0, 10) || [],
            auto_generated:
              structuralIssues.duplication?.auto_generated?.slice(0, 10) || [],
          },
          hierarchy: {
            overloaded_root:
              structuralIssues.hierarchy?.overloaded_root || false,
            root_sections_count:
              structuralIssues.hierarchy?.root_sections_count || 0,
            flat_sections: structuralIssues.hierarchy?.flat_sections || [],
          },
          crawl_waste: {
            faceted: structuralIssues.crawl_waste?.faceted?.slice(0, 10) || [],
            orphaned:
              structuralIssues.crawl_waste?.orphaned?.slice(0, 10) || [],
          },
        }
      : {};

    // Always use file-based output format
    const userPrompt = `EXECUTION MODE: FILE-BASED OUTPUT (REQUIRED)

This prompt can be used with Grok (x.ai/grok). Attach the sitemap.json file and paste this prompt.

You MUST generate downloadable files to avoid truncation, partial output, or broken JSON.

INPUTS:
1. Current sitemap tree (JSON) - attached as sitemap.json file
   - The file contains a \`pages\` array with all working pages
   - The file contains an \`issues\` section with \`brokenLinks\` array
2. Detected structural issues (JSON)

SITE CONTEXT:
- Site type: ${siteType}
- Content intent: ${contentIntent}
- SEO goal: ${seoGoal}
- Indexing constraints: account & filters must be noindex
- Maximum depth allowed: ${maxDepth}

TASKS:
1. Analyze the current sitemap structure and identify improvements
2. Review the \`issues.brokenLinks\` section in the attached sitemap.json file:
   - Each broken link includes: url, errorType (404, 403, 500, Timeout, etc.), parentUrl, depth, originalHref, and recommendation
   - Use the \`recommendation\` field (e.g., "Redirect or Remove", "Investigate") to suggest appropriate fixes
   - For 404 errors with "Redirect or Remove" recommendation: suggest redirects to appropriate pages or mark for removal
   - For other error types: suggest investigation and appropriate actions
3. Ensure depth ≤ ${maxDepth}
4. Consolidate flat or fragmented sections into logical hubs
5. Return a redirect map (301) for all moved paths AND broken links that should be redirected
6. List index/noindex recommendations
7. Explain structural changes briefly, including how broken links are addressed

NOTE: The sitemap.json file is attached to this conversation. Please analyze the structure from the attached file, paying special attention to the \`issues.brokenLinks\` section to suggest fixes for broken links.

STRUCTURAL ISSUES:
${JSON.stringify(issuesFormatted, null, 2)}

📌 OUTPUT REQUIREMENTS (FILE-BASED):

You MUST provide ONLY the Excel file as downloadable file contents or code blocks:

new_sitemap.xlsx - Excel file with hierarchical columns: Top Level Navigation Landing Page (1st level), 2nd Level Subpage, 3rd Level Subpage, 4th Level Subpage, 5th Level Subpage, 6th Level Subpage, 7th Level Subpage, Notes (provide as CSV format or structured data that can be converted to Excel)

CRITICAL VALIDATION RULES:
❌ If Excel file is incomplete → RESPONSE IS INVALID
❌ If data is truncated or broken → RESPONSE IS INVALID
❌ If branches are collapsed or placeholders used → RESPONSE IS INVALID

✅ CORRECT EXECUTION:
- Every URL from the CURRENT SITEMAP TREE input MUST appear in the Excel file (possibly restructured)
- Excel file must include all URLs with hierarchical columns: Top Level Navigation Landing Page (1st level), 2nd Level Subpage, 3rd Level Subpage, 4th Level Subpage, 5th Level Subpage, 6th Level Subpage, 7th Level Subpage, Notes
- Use code blocks with language tags: \`\`\`csv or \`\`\`json for the Excel data
- Fully expand all tree branches - no collapsing, no placeholders
- Address broken links from \`issues.brokenLinks\` section: include redirects in redirect_map or mark for removal in Notes column

ALTERNATIVE: If file generation is not possible, use CHUNKED RESPONSE mode:
- Provide new_sitemap.xlsx data in chunks (CSV format or structured JSON with hierarchical columns: Top Level Navigation Landing Page (1st level), 2nd Level Subpage, 3rd Level Subpage, 4th Level Subpage, 5th Level Subpage, 6th Level Subpage, 7th Level Subpage, Notes)

Each chunk must be clearly labeled (e.g., "EXCEL_DATA — Part 1/3").

Note: For Excel file, provide data in CSV format or as structured JSON array that can be easily converted to Excel with hierarchical columns: Top Level Navigation Landing Page (1st level), 2nd Level Subpage, 3rd Level Subpage, 4th Level Subpage, 5th Level Subpage, 6th Level Subpage, 7th Level Subpage, Notes. Each row should represent a page, with the page title in the appropriate level column based on its depth in the hierarchy.

Remember: Do NOT invent new content. Only restructure existing paths.`;

    return {
      improvement: {
        systemPrompt: systemPrompt,
        userPrompt: userPrompt,
        fullPrompt: `SYSTEM PROMPT:\n${systemPrompt}\n\n---\n\nUSER PROMPT:\n${userPrompt}`,
      },
    };
  } catch (error) {
    console.error("Error generating prompts with data:", error);
    return {
      improvement: null,
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
  LARGE_SITEMAP_THRESHOLD,
};
