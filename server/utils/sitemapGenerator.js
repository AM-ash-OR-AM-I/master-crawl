const { pool } = require('../db/init');
const XLSX = require('xlsx');

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
 * Generate tree diagram representation (improved to match revize-ai format)
 */
function generateTreeDiagram(pages, baseUrl) {
  if (!pages || pages.length === 0) {
    return `${baseUrl}\n└── (No pages found)`;
  }
  
  const url = new URL(baseUrl);
  const base = `${url.protocol}//${url.host}`;
  
  // Find root page (homepage)
  const rootPage = pages.find(p => {
    try {
      const u = new URL(p.url);
      return (u.pathname === '/' || u.pathname === '') && (!u.hash || u.hash === '' || u.hash === '#');
    } catch {
      return false;
    }
  }) || pages[0];
  
  // Build a map of pages by URL for quick lookup
  const pageMap = new Map();
  pages.forEach(page => {
    pageMap.set(page.url, {
      ...page,
      children: []
    });
  });
  
  // Build parent-child relationships
  const rootNodes = [];
  pages.forEach(page => {
    const node = pageMap.get(page.url);
    if (page.parentUrl && pageMap.has(page.parentUrl)) {
      const parent = pageMap.get(page.parentUrl);
      if (!parent.children) parent.children = [];
      parent.children.push(node);
    } else if (page.url === rootPage?.url || (!page.parentUrl && page.depth === 0)) {
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
    output += buildTreeTextFromNode(node, '', isLast);
  });
  
  return output;
}

/**
 * Build tree text from a node (recursive)
 */
function buildTreeTextFromNode(node, prefix, isLast) {
  if (!node) return '';
  
  let output = '';
  const title = node.title && node.title !== 'ERROR: Error' && node.title !== 'Error' && node.title !== 'ERROR'
    ? node.title
    : (() => {
        try {
          const urlObj = new URL(node.url);
          const hash = urlObj.hash?.substring(1);
          const pathParts = urlObj.pathname.split('/').filter(p => p);
          if (hash && hash.startsWith('/')) {
            return hash.substring(1).split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
          }
          return pathParts.length > 0 
            ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : 'Home';
        } catch {
          return 'Page';
        }
      })();
  
  const connector = isLast ? '└── ' : '├── ';
  output += prefix + connector + `📄 ${title}\n`;
  output += prefix + (isLast ? '    ' : '│   ') + `   ${node.url}\n`;
  
  // Add children
  if (node.children && node.children.length > 0) {
    node.children.forEach((child, idx) => {
      const isLastChild = idx === node.children.length - 1;
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      output += buildTreeTextFromNode(child, childPrefix, isLastChild);
    });
  }
  
  return output;
}

// Legacy function kept for backward compatibility (not used in new implementation)
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
        const pageTitle = page.title && page.title !== 'ERROR: Error' && page.title !== 'Error' && page.title !== 'ERROR'
          ? page.title
          : 'Untitled';
        output += pagePrefix + (isLastPage ? '└── ' : '├── ') + `📄 ${pageTitle}\n`;
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
  // Clean up titles - replace "ERROR: Error" with better titles
  const cleanedPages = pages.map(page => {
    let title = page.title;
    if (!title || title === 'ERROR: Error' || title === 'Error' || title === 'ERROR') {
      try {
        const urlObj = new URL(page.url);
        const hash = urlObj.hash?.substring(1);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        if (hash && hash.startsWith('/')) {
          title = hash.substring(1).split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
        } else {
          title = pathParts.length > 0 
            ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : 'Home';
        }
      } catch {
        title = 'Page';
      }
    }
    return {
      url: page.url,
      title: title,
      depth: page.depth,
      parentUrl: page.parentUrl
    };
  });
  
  return {
    version: '1.0',
    totalPages: cleanedPages.length,
    generatedAt: new Date().toISOString(),
    pages: cleanedPages
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
 * Generate Excel sitemap from pages with hierarchical structure
 */
function generateExcelSitemap(pages, baseUrl) {
  // Clean up titles
  const cleanedPages = pages.map(page => {
    let title = page.title;
    if (!title || title === 'ERROR: Error' || title === 'Error' || title === 'ERROR') {
      try {
        const urlObj = new URL(page.url);
        const hash = urlObj.hash?.substring(1);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        if (hash && hash.startsWith('/')) {
          title = hash.substring(1).split('/').pop()?.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'Page';
        } else {
          title = pathParts.length > 0 
            ? pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
            : 'Home';
        }
      } catch {
        title = 'Page';
      }
    }
    return {
      url: page.url,
      title: title,
      depth: page.depth,
      parentUrl: page.parentUrl || ''
    };
  });

  // Sort pages by depth and title for consistent ordering
  const sortedPages = [...cleanedPages].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return (a.title || '').localeCompare(b.title || '');
  });
  
  // Create rows using the actual depth from crawl data
  const hierarchicalRows = sortedPages.map(page => {
    // Use the actual crawl depth to place the title in the correct column
    const depth = page.depth || 0;
    
    return {
      'Top Level Navigation Landing Page (1st level)': depth === 0 ? page.title : '',
      '2nd Level Subpage': depth === 1 ? page.title : '',
      '3rd Level Subpage': depth === 2 ? page.title : '',
      '4th Level Subpage': depth === 3 ? page.title : '',
      '5th Level Subpage': depth === 4 ? page.title : '',
      '6th Level Subpage': depth === 5 ? page.title : '',
      '7th Level Subpage': depth >= 6 ? page.title : '',
      'Notes': ''
    };
  });
  
  // Create workbook and worksheet
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(hierarchicalRows);
  
  // Set column widths
  worksheet['!cols'] = [
    { wch: 40 }, // Top Level Navigation Landing Page (1st level)
    { wch: 35 }, // 2nd Level Subpage
    { wch: 35 }, // 3rd Level Subpage
    { wch: 35 }, // 4th Level Subpage
    { wch: 35 }, // 5th Level Subpage
    { wch: 35 }, // 6th Level Subpage
    { wch: 35 }, // 7th Level Subpage
    { wch: 30 }  // Notes
  ];
  
  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sitemap');
  
  // Generate Excel file buffer
  const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  
  return excelBuffer;
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
    case 'excel':
      return {
        content: generateExcelSitemap(pages, baseUrl),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `sitemap-${jobId}.xlsx`
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
  generateExcelSitemap,
  getSitemap
};

