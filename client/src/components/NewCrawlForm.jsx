import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';

function NewCrawlForm({ onSubmit }) {
  const [websites, setWebsites] = useState(['']);
  const [maxDepth, setMaxDepth] = useState(3);
  const [maxPages, setMaxPages] = useState(500);
  const [useSitemap, setUseSitemap] = useState(false);
  const [checkRedirectDuplicates, setCheckRedirectDuplicates] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleWebsiteChange = (index, value) => {
    const newWebsites = [...websites];
    newWebsites[index] = value;
    setWebsites(newWebsites);
  };

  const addWebsite = () => {
    setWebsites([...websites, '']);
  };

  const removeWebsite = (index) => {
    if (websites.length > 1) {
      const newWebsites = websites.filter((_, i) => i !== index);
      setWebsites(newWebsites);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    
    const validWebsites = websites.filter(w => w.trim());
    if (validWebsites.length === 0) {
      setError('Please add at least one website');
      return;
    }

    setLoading(true);
    try {
      await onSubmit(validWebsites, maxDepth, maxPages, useSitemap, checkRedirectDuplicates);
      setSuccess(true);
      setWebsites(['']);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to start crawl');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader className="text-center pb-4">
        <div className="flex justify-center mb-4">
          <div className="p-3 rounded-full bg-primary/10">
            <svg
              className="h-8 w-8 text-primary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
              />
            </svg>
          </div>
        </div>
        <CardTitle className="text-2xl">Analyze Your Website</CardTitle>
        <CardDescription className="text-base">
          Enter any URL to crawl the site and generate an AI-powered sitemap analysis
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {websites.map((website, index) => (
            <div key={index} className="flex gap-2">
              <div className="relative flex-1">
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                  />
                </svg>
                <Input
                  type="text"
                  placeholder="https://example.com"
                  value={website}
                  onChange={(e) => handleWebsiteChange(index, e.target.value)}
                  disabled={loading}
                  className="pl-10 h-12 text-base"
                />
              </div>
              {websites.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => removeWebsite(index)}
                  disabled={loading}
                  className="h-12"
                >
                  ×
                </Button>
              )}
            </div>
          ))}
          
          <Button
            type="button"
            variant="ghost"
            onClick={addWebsite}
            disabled={loading}
            className="w-full"
          >
            + Add Another Website
          </Button>

          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full justify-between text-muted-foreground"
            >
              Advanced Options
              <svg
                className={`h-4 w-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </Button>
            
            {showAdvanced && (
              <div className="pt-4 space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">Max Depth</label>
                    <span className="text-sm font-mono text-muted-foreground">{maxDepth} level{maxDepth > 1 ? 's' : ''}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(parseInt(e.target.value))}
                    disabled={loading}
                    className="w-full"
                  />
                </div>
                
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium">Max Pages</label>
                    <span className="text-sm font-mono text-muted-foreground">{maxPages}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="12000"
                    step="100"
                    value={maxPages}
                    onChange={(e) => setMaxPages(parseInt(e.target.value))}
                    disabled={loading}
                    className="w-full"
                  />
                </div>
                
                <div className="pt-2 space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={useSitemap}
                        onChange={(e) => setUseSitemap(e.target.checked)}
                        disabled={loading}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors"></div>
                      <div className="absolute left-1 top-1 w-4 h-4 bg-background rounded-full shadow peer-checked:translate-x-5 transition-transform"></div>
                    </div>
                    <div>
                      <span className="text-sm font-medium">Use sitemap.xml</span>
                      <p className="text-xs text-muted-foreground">
                        {useSitemap 
                          ? "Faster crawling using sitemap.xml (may show flat hierarchy)" 
                          : "Pure link crawling (accurate depth hierarchy)"}
                      </p>
                    </div>
                  </label>
                  
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div className="relative">
                      <input
                        type="checkbox"
                        checked={checkRedirectDuplicates}
                        onChange={(e) => setCheckRedirectDuplicates(e.target.checked)}
                        disabled={loading}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors"></div>
                      <div className="absolute left-1 top-1 w-4 h-4 bg-background rounded-full shadow peer-checked:translate-x-5 transition-transform"></div>
                    </div>
                    <div>
                      <span className="text-sm font-medium">Check redirect duplicates</span>
                      <p className="text-xs text-muted-foreground">
                        {checkRedirectDuplicates 
                          ? "Skip URLs that redirect to already-crawled pages" 
                          : "Crawl all URLs even if they redirect to already-crawled pages"}
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}
          {success && (
            <div className="p-3 rounded-md bg-green-500/10 text-green-500 text-sm">
              ✅ Crawl started successfully!
            </div>
          )}

          <Button
            type="submit"
            className="w-full h-12 text-base"
            disabled={loading}
          >
            {loading ? (
              <>
                <svg className="mr-2 h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Analyzing...
              </>
            ) : (
              'Analyze Website'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default NewCrawlForm;

