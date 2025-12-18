const OpenAI = require('openai');
const { pool } = require('../db/init');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_TOKENS_PER_CHUNK = 100000; // Conservative limit
const MAX_OUTPUT_TOKENS = 4000;

/**
 * Token-safe AI processing using hierarchical chunking
 */
async function processSitemap(jobId, sitemap) {
  try {
    // Stage 1: Structural Compression
    const compressed = compressSitemap(sitemap);
    
    // Stage 2: Section-Level Chunking
    const chunks = chunkSitemap(compressed);
    
    // Stage 3: Process each chunk
    const chunkInsights = [];
    for (const chunk of chunks) {
      const insight = await analyzeChunk(chunk);
      chunkInsights.push(insight);
    }
    
    // Stage 4: Global Merge
    const globalPlan = await mergeInsights(chunkInsights, compressed);
    
    // Stage 5: Apply optimizations
    const optimizedSitemap = applyOptimizations(sitemap, globalPlan);
    
    // Extract recommendations for display
    const recommendations = extractRecommendations(globalPlan);
    
    return {
      optimizedSitemap,
      recommendations,
    };
  } catch (error) {
    console.error('AI processing error:', error);
    // Return original sitemap if AI fails
    return {
      optimizedSitemap: sitemap,
      recommendations: [],
    };
  }
}

/**
 * Stage 1: Compress sitemap to reduce token usage
 */
function compressSitemap(sitemap) {
  const compressed = {};
  
  function compressNode(node, path = '') {
    const result = {
      count: node._count || 0,
      depth: node._depth || 0,
      children: {},
    };
    
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('_')) continue;
      
      const newPath = path ? `${path}/${key}` : `/${key}`;
      result.children[key] = compressNode(value, newPath);
    }
    
    return result;
  }
  
  return compressNode(sitemap);
}

/**
 * Stage 2: Split into chunks by top-level paths
 */
function chunkSitemap(compressed) {
  const chunks = [];
  
  for (const [topLevel, data] of Object.entries(compressed.children || {})) {
    chunks.push({
      path: `/${topLevel}`,
      structure: data,
    });
  }
  
  // If no top-level structure, return single chunk
  if (chunks.length === 0) {
    chunks.push({
      path: '/',
      structure: compressed,
    });
  }
  
  return chunks;
}

/**
 * Stage 3: Analyze individual chunk
 */
async function analyzeChunk(chunk) {
  const prompt = `You are a sitemap optimization expert. Analyze this sitemap section and provide recommendations.

Sitemap Section: ${chunk.path}
Structure: ${JSON.stringify(chunk.structure, null, 2)}

Provide a JSON response with:
{
  "issues": ["list of issues found"],
  "recommendations": [
    {
      "category": "URL_DEPTH|GROUPING|DUPLICATES|NAVIGATION",
      "before": "current structure",
      "after": "suggested structure",
      "explanation": "why this change improves UX"
    }
  ]
}

Keep recommendations concise and actionable.`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'You are a sitemap optimization expert. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
    
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Chunk analysis error:', error);
    return { issues: [], recommendations: [] };
  }
}

/**
 * Stage 4: Merge all chunk insights into global plan
 */
async function mergeInsights(chunkInsights, compressed) {
  const allRecommendations = chunkInsights.flatMap(c => c.recommendations || []);
  const allIssues = chunkInsights.flatMap(c => c.issues || []);
  
  const prompt = `You are a sitemap optimization expert. Merge these recommendations into a coherent global optimization plan.

All Issues Found: ${JSON.stringify(allIssues, null, 2)}
All Recommendations: ${JSON.stringify(allRecommendations, null, 2)}
Full Sitemap Structure: ${JSON.stringify(compressed, null, 2)}

Provide a JSON response with a prioritized optimization plan:
{
  "priority": "HIGH|MEDIUM|LOW",
  "optimizations": [
    {
      "category": "URL_DEPTH|GROUPING|DUPLICATES|NAVIGATION",
      "before": "current structure",
      "after": "optimized structure",
      "explanation": "detailed explanation",
      "impact": "HIGH|MEDIUM|LOW"
    }
  ]
}`;

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: 'You are a sitemap optimization expert. Always respond with valid JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : content;
    
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error('Merge insights error:', error);
    return { priority: 'MEDIUM', optimizations: allRecommendations };
  }
}

/**
 * Apply optimizations to sitemap
 */
function applyOptimizations(sitemap, globalPlan) {
  // For now, return the original sitemap
  // In production, you'd apply the structural changes here
  // This is a simplified version - full implementation would restructure the tree
  return sitemap;
}

/**
 * Extract recommendations for database storage
 */
function extractRecommendations(globalPlan) {
  const recommendations = [];
  
  if (globalPlan.optimizations) {
    for (const opt of globalPlan.optimizations) {
      recommendations.push({
        category: opt.category || 'GENERAL',
        before: opt.before,
        after: opt.after,
        explanation: opt.explanation || 'AI-optimized structure',
      });
    }
  }
  
  return recommendations;
}

module.exports = { processSitemap };

