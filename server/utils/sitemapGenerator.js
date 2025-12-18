const { pool } = require('../db/init');

/**
 * Generate XML sitemap from pages
 */
function generateXMLSitemap(pages, baseUrl) {
  const url = new URL(baseUrl);
  const base = `${url.protocol}//${url.host}`;
  const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  
  for (const page of pages) {
    xml += '  <url>\n';
    xml += `    <loc>${escapeXML(page.url)}</loc>\n`;
    xml += `    <lastmod>${now}</lastmod>\n`;
    xml += `    <changefreq>weekly</changefreq>\n`;
    xml += `    <priority>${calculatePriority(page.depth)}</priority>\n`;
    xml += '  </url>\n';
  }
  
  xml += '</urlset>';
  return xml;
}

/**
 * Generate tree diagram representation
 */
function generateTreeDiagram(pages, baseUrl) {
  const url = new URL(baseUrl);
  const base = `${url.protocol}//${url.host}`;
  
  // Build tree structure
  const tree = {
    name: 'Root',
    path: '/',
    fullUrl: base,
    children: {},
    pages: []
  };
  
  // Check if homepage exists (without hash)
  const homepage = pages.find(p => {
    try {
      const u = new URL(p.url);
      return (u.pathname === '/' || u.pathname === '') && (!u.hash || u.hash === '');
    } catch {
      return false;
    }
  });
  
  if (homepage) {
    tree.pages.push({
      url: homepage.url,
      title: homepage.title || 'Homepage',
      depth: homepage.depth
    });
  }
  
  for (const page of pages) {
    const urlObj = new URL(page.url);
    const pathParts = urlObj.pathname.split('/').filter(p => p);
    const hasHash = urlObj.hash && urlObj.hash !== '';
    
    // Handle hash URLs on homepage
    if (hasHash && pathParts.length === 0) {
      // Hash URL on homepage - add to root pages
      tree.pages.push({
        url: page.url,
        title: page.title || urlObj.hash.substring(1) || 'Hash Route',
        depth: page.depth
      });
      continue;
    }
    
    // Skip homepage without hash (already added above)
    if (pathParts.length === 0 && !hasHash) continue;
    
    let current = tree;
    let path = '';
    
    // Build path structure
    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      path += '/' + part;
      
      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          path: path,
          fullUrl: base + path,
          children: {},
          pages: []
        };
      }
      
      current = current.children[part];
    }
    
    // Add page to the appropriate node (both regular and hash URLs)
    current.pages.push({
      url: page.url,
      title: page.title || (hasHash ? urlObj.hash.substring(1) : pathParts[pathParts.length - 1]) || 'Page',
      depth: page.depth
    });
  }
  
  // Convert to text tree
  let output = `${base}\n`;
  
  // Display all pages at root level (including hash URLs)
  if (tree.pages.length > 0) {
    for (let i = 0; i < tree.pages.length; i++) {
      const page = tree.pages[i];
      const isLast = i === tree.pages.length - 1 && Object.keys(tree.children).length === 0;
      output += (isLast ? '└── ' : '├── ') + `📄 ${page.title}\n`;
      output += (isLast ? '    ' : '│   ') + `   ${page.url}\n`;
    }
  }
  
  // Display children
  if (Object.keys(tree.children).length > 0) {
    const prefix = tree.pages.length > 0 ? '│   ' : '';
    output += buildTreeText(tree.children, prefix, tree.pages.length === 0 && Object.keys(tree.children).length === 1);
  }
  
  return output;
}

function buildTreeText(node, prefix, isLast) {
  let output = '';
  const entries = Object.entries(node);
  
  for (let idx = 0; idx < entries.length; idx++) {
    const [key, value] = entries[idx];
    const isLastItem = idx === entries.length - 1;
    const currentPrefix = isLast ? '└── ' : '├── ';
    const nextPrefix = isLast ? '    ' : '│   ';
    
    output += prefix + currentPrefix + key;
    if (value.pages && value.pages.length > 0) {
      output += ` (${value.pages.length} page${value.pages.length > 1 ? 's' : ''})`;
    }
    output += '\n';
    
    if (value.pages && value.pages.length > 0) {
      for (let pIdx = 0; pIdx < value.pages.length; pIdx++) {
        const page = value.pages[pIdx];
        const isLastPage = pIdx === value.pages.length - 1 && Object.keys(value.children).length === 0;
        const pagePrefix = prefix + (isLastItem ? '    ' : '│   ');
        output += pagePrefix + (isLastPage ? '└── ' : '├── ') + `📄 ${page.title || 'Untitled'}\n`;
        output += pagePrefix + (isLastPage ? '    ' : '│   ') + `   ${page.url}\n`;
      }
    }
    
    if (Object.keys(value.children).length > 0) {
      const childPrefix = prefix + (isLastItem ? '    ' : '│   ');
      output += buildTreeText(value.children, childPrefix, isLastItem);
    }
  }
  
  return output;
}

/**
 * Generate JSON sitemap (already exists, but ensure it's complete)
 */
function generateJSONSitemap(pages) {
  return {
    version: '1.0',
    totalPages: pages.length,
    generatedAt: new Date().toISOString(),
    pages: pages.map(page => ({
      url: page.url,
      title: page.title,
      depth: page.depth,
      parentUrl: page.parentUrl
    }))
  };
}

function escapeXML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function calculatePriority(depth) {
  // Homepage = 1.0, depth 1 = 0.8, depth 2 = 0.6, etc.
  return Math.max(0.1, 1.0 - (depth * 0.2)).toFixed(1);
}

/**
 * Get sitemap in requested format
 */
async function getSitemap(jobId, format = 'json') {
  const pagesResult = await pool.query(
    'SELECT url, title, depth, parent_url FROM pages WHERE job_id = $1 ORDER BY depth, url',
    [jobId]
  );
  
  const jobResult = await pool.query(
    'SELECT domain FROM crawl_jobs WHERE id = $1',
    [jobId]
  );
  
  if (jobResult.rows.length === 0) {
    throw new Error('Job not found');
  }
  
  const baseUrl = jobResult.rows[0].domain.startsWith('http') 
    ? jobResult.rows[0].domain 
    : `https://${jobResult.rows[0].domain}`;
  
  const pages = pagesResult.rows.map(row => ({
    url: row.url,
    title: row.title,
    depth: row.depth,
    parentUrl: row.parent_url
  }));
  
  switch (format.toLowerCase()) {
    case 'xml':
      return {
        content: generateXMLSitemap(pages, baseUrl),
        contentType: 'application/xml',
        filename: `sitemap-${jobId}.xml`
      };
    case 'tree':
      return {
        content: generateTreeDiagram(pages, baseUrl),
        contentType: 'text/plain',
        filename: `sitemap-${jobId}.txt`
      };
    case 'json':
    default:
      return {
        content: JSON.stringify(generateJSONSitemap(pages), null, 2),
        contentType: 'application/json',
        filename: `sitemap-${jobId}.json`
      };
  }
}

module.exports = {
  generateXMLSitemap,
  generateTreeDiagram,
  generateJSONSitemap,
  getSitemap
};

