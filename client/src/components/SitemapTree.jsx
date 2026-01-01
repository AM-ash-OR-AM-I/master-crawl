import React, { useState } from 'react';
import { cn } from '../lib/utils';

function TreeNode({ node, level = 0, isLast = false, parentPath = [] }) {
  const [isExpanded, setIsExpanded] = useState(level < 2); // Auto-expand first 2 levels
  const hasChildren = node.children && node.children.length > 0;

  const toggleExpand = () => {
    if (hasChildren) {
      setIsExpanded(!isExpanded);
    }
  };

  // Build tree prefix with lines
  const getTreePrefix = () => {
    if (level === 0) return '';
    
    let prefix = '';
    for (let i = 0; i < level - 1; i++) {
      prefix += parentPath[i] ? '    ' : '│   ';
    }
    prefix += isLast ? '└── ' : '├── ';
    return prefix;
  };

  return (
    <div className="select-none font-mono text-sm">
      <div
        className={cn(
          'flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/50 transition-colors group',
          level === 0 && 'font-semibold text-base'
        )}
        onClick={toggleExpand}
      >
        <span className="text-muted-foreground whitespace-pre">
          {getTreePrefix()}
        </span>
        <div className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
          {hasChildren ? (
            <span className="text-muted-foreground text-xs w-4 flex-shrink-0 flex items-center justify-center">
              {isExpanded ? (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </span>
          ) : (
            <span className="w-4" />
          )}
          <span className={cn(
            'text-sm truncate font-sans flex items-center gap-1.5',
            level === 0 && 'font-semibold',
            node.isFragment && 'text-muted-foreground'
          )}>
            {node.isFragment && (
              <span className="text-xs text-muted-foreground" title="Page Section">
                #
              </span>
            )}
            {node.title || node.url || 'Untitled'}
          </span>
          {node.url && node.url !== node.title && (
            <a
              href={node.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-muted-foreground hover:text-primary ml-2 truncate flex-shrink-0 max-w-xs font-sans"
              title={node.url}
            >
              {node.url.length > 50 ? `${node.url.substring(0, 50)}...` : node.url}
            </a>
          )}
        </div>
      </div>
      
      {hasChildren && isExpanded && (
        <div>
          {node.children.map((child, index) => {
            const isLastChild = index === node.children.length - 1;
            const newParentPath = [...parentPath, !isLast];
            
            return (
              <TreeNode
                key={child.id || child.url || index}
                node={child}
                level={level + 1}
                isLast={isLastChild}
                parentPath={newParentPath}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SitemapTree({ sitemap }) {
  if (!sitemap) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Sitemap not available yet.</p>
      </div>
    );
  }

  // Handle different sitemap structures
  let rootNode = sitemap;
  
  // If sitemap has a root property or is an array
  if (sitemap.root) {
    rootNode = sitemap.root;
  } else if (Array.isArray(sitemap)) {
    // If it's an array, create a root node
    rootNode = {
      id: 'root',
      title: 'Root',
      url: '',
      children: sitemap
    };
  }

  // Extract base URL from root node for display
  let baseUrl = '';
  if (rootNode.url) {
    try {
      const url = new URL(rootNode.url);
      baseUrl = `${url.protocol}//${url.host}`;
    } catch (e) {
      baseUrl = rootNode.url;
    }
  }

  return (
    <div className="border rounded-lg bg-card overflow-auto max-h-[600px]">
      {baseUrl && (
        <div className="p-4 border-b border-border bg-muted/30">
          <div className="font-semibold text-sm">{baseUrl}</div>
        </div>
      )}
      <div className="p-2">
        <TreeNode node={rootNode} level={0} isLast={true} parentPath={[]} />
      </div>
    </div>
  );
}

export default SitemapTree;

