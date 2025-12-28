import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';
import SitemapTree from './SitemapTree';

function JobDetails({ job, onClose }) {
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [improving, setImproving] = useState(false);
  const [sitemapView, setSitemapView] = useState('tree'); // 'tree' or 'json'
  const [copied, setCopied] = useState({});

  useEffect(() => {
    fetchDetails();
  }, [job.id]);

  const fetchDetails = async () => {
    try {
      const response = await axios.get(`/api/crawl/${job.id}`);
      console.log('Job details response:', response.data);
      console.log('Prompts data:', response.data.prompts);
      setDetails(response.data);
    } catch (error) {
      console.error('Error fetching job details:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleImproveWithAI = async () => {
    if (!details || details.status !== 'COMPLETED') {
      return;
    }
    
    setImproving(true);
    try {
      await axios.post(`/api/crawl/${job.id}/improve`);
      await fetchDetails();
      alert('AI improvement completed! Check the recommendations tab.');
    } catch (error) {
      console.error('Error improving sitemap:', error);
      alert(error.response?.data?.error || 'Failed to improve sitemap');
    } finally {
      setImproving(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <Card className="w-full max-w-2xl mx-4">
          <CardContent className="p-6">
            <div className="animate-pulse text-muted-foreground">Loading...</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!details) {
    return null;
  }

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <Card 
        className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col bg-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 border-b border-border">
          <h2 className="text-2xl font-semibold">{job.website}</h2>
          <div className="flex items-center gap-2">
            {details && details.status === 'COMPLETED' && (
              <Button
                onClick={handleImproveWithAI}
                disabled={improving}
                className="gap-2"
              >
                {improving ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Improving...
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                    </svg>
                    Improve with AI
                  </>
                )}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose}>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </Button>
          </div>
        </div>

        <div className="flex border-b border-border">
          <button
            className={cn(
              'px-6 py-3 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'overview'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setActiveTab('overview')}
          >
            Overview
          </button>
          <button
            className={cn(
              'px-6 py-3 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'recommendations'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setActiveTab('recommendations')}
          >
            AI Recommendations ({details.recommendations?.length || 0})
          </button>
          <button
            className={cn(
              'px-6 py-3 text-sm font-medium border-b-2 transition-colors',
              activeTab === 'sitemap'
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
            onClick={() => setActiveTab('sitemap')}
          >
            Sitemap
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'overview' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-sm text-muted-foreground">Status</label>
                  <div className="mt-1">
                    <Badge variant="secondary">{details.status}</Badge>
                  </div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Pages Crawled</label>
                  <div className="mt-1 font-medium">{details.pagesCount || 0}</div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Max Depth</label>
                  <div className="mt-1 font-medium">{details.max_depth}</div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Max Pages</label>
                  <div className="mt-1 font-medium">{details.max_pages}</div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Started At</label>
                  <div className="mt-1 text-sm">
                    {details.started_at ? new Date(details.started_at).toLocaleString() : 'N/A'}
                  </div>
                </div>
                <div>
                  <label className="text-sm text-muted-foreground">Completed At</label>
                  <div className="mt-1 text-sm">
                    {details.completed_at ? new Date(details.completed_at).toLocaleString() : 'N/A'}
                  </div>
                </div>
              </div>
              {details.error_message && (
                <div className="p-4 rounded-md bg-destructive/10 text-destructive">
                  <strong>Error:</strong> {details.error_message}
                </div>
              )}
            </div>
          )}

          {activeTab === 'recommendations' && (
            <div className="space-y-4">
              {/* AI Improvement Prompt */}
              {details.prompts && details.prompts.improvement && (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold">AI Sitemap Improvement Prompt</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Copy this prompt and paste it into ChatGPT to get AI-powered sitemap optimization recommendations. 
                      The prompt includes your current sitemap structure and detected issues.
                    </p>
                  </div>
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-muted-foreground">
                          Complete Prompt (System + User)
                        </label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const copyToClipboard = async () => {
                              try {
                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                  await navigator.clipboard.writeText(details.prompts.improvement.fullPrompt);
                                  setCopied({ ...copied, improvement: true });
                                  setTimeout(() => {
                                    setCopied({ ...copied, improvement: false });
                                  }, 2000);
                                } else {
                                  const textArea = document.createElement('textarea');
                                  textArea.value = details.prompts.improvement.fullPrompt;
                                  textArea.style.position = 'fixed';
                                  textArea.style.left = '-999999px';
                                  document.body.appendChild(textArea);
                                  textArea.focus();
                                  textArea.select();
                                  try {
                                    document.execCommand('copy');
                                    setCopied({ ...copied, improvement: true });
                                    setTimeout(() => {
                                      setCopied({ ...copied, improvement: false });
                                    }, 2000);
                                  } catch (err) {
                                    console.error('Fallback copy failed:', err);
                                  }
                                  document.body.removeChild(textArea);
                                }
                              } catch (err) {
                                console.error('Failed to copy:', err);
                                alert('Failed to copy. Please select and copy manually.');
                              }
                            };
                            copyToClipboard();
                          }}
                          className="gap-2"
                        >
                          {copied.improvement ? (
                            <>
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                              Copied!
                            </>
                          ) : (
                            <>
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                              Copy Prompt
                            </>
                          )}
                        </Button>
                      </div>
                      <pre className="mt-2 p-3 rounded bg-muted text-xs overflow-auto font-mono whitespace-pre-wrap break-words max-h-96">
                        {details.prompts.improvement.fullPrompt}
                      </pre>
                    </CardContent>
                  </Card>
                </div>
              )}
              
              {/* Show message if no prompts available */}
              {(!details.prompts || !details.prompts.improvement) && (
                <Card>
                  <CardContent className="p-4">
                    <p className="text-sm text-muted-foreground">
                      No prompts available yet. The prompt will be generated automatically when you view job details after crawling.
                    </p>
                  </CardContent>
                </Card>
              )}
              
              {/* Recommendations Section */}
              <div className="mt-6">
                <h3 className="text-lg font-semibold mb-4">AI Recommendations</h3>
              </div>
              {details.recommendations && details.recommendations.length > 0 ? (
                <div className="space-y-4">
                  {details.recommendations.map((rec) => (
                    <Card key={rec.id}>
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant="outline">{rec.category}</Badge>
                        </div>
                        <div className="grid md:grid-cols-2 gap-4 mb-4">
                          <div>
                            <label className="text-sm font-medium text-muted-foreground">Before</label>
                            <pre className="mt-1 p-2 rounded bg-muted text-xs overflow-auto">
                              {JSON.stringify(rec.before, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <label className="text-sm font-medium text-muted-foreground">After</label>
                            <pre className="mt-1 p-2 rounded bg-muted text-xs overflow-auto">
                              {JSON.stringify(rec.after, null, 2)}
                            </pre>
                          </div>
                        </div>
                        <div>
                          <label className="text-sm font-medium text-muted-foreground">Explanation</label>
                          <p className="mt-1 text-sm">{rec.explanation}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-muted-foreground">
                    {details.status === 'AI_ANALYSIS' || details.status === 'PROCESSING'
                      ? 'AI analysis in progress...'
                      : 'No recommendations available yet.'}
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'sitemap' && (
            <div className="space-y-4">
              {details.sitemap?.original_sitemap ? (
                <>
                  <div className="flex items-center justify-between">
                    <div className="flex gap-2">
                      <Button
                        variant={sitemapView === 'tree' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setSitemapView('tree')}
                      >
                        Tree View
                      </Button>
                      <Button
                        variant={sitemapView === 'json' ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setSitemapView('json')}
                      >
                        JSON View
                      </Button>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={`/api/crawl/${job.id}/download/json`}
                          download
                        >
                          Download JSON
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={`/api/crawl/${job.id}/download/excel`}
                          download
                        >
                          Download Excel
                        </a>
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={`/api/crawl/${job.id}/download/tree`}
                          download
                        >
                          Download Tree
                        </a>
                      </Button>
                    </div>
                  </div>
                  {sitemapView === 'tree' ? (
                    <SitemapTree sitemap={details.sitemap.original_sitemap} />
                  ) : (
                    <Card>
                      <CardContent className="p-4">
                        <pre className="text-xs overflow-auto max-h-96 bg-muted p-4 rounded">
                          {JSON.stringify(
                            details.sitemap.original_sitemap,
                            null,
                            2
                          )}
                        </pre>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <div className="text-center py-12">
                  <p className="text-muted-foreground">Sitemap not available yet.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export default JobDetails;
