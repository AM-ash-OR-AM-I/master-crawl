import React, { useState, useEffect } from 'react';
import axios from 'axios';
import CrawlDashboard from './components/CrawlDashboard';
import NewCrawlForm from './components/NewCrawlForm';
import { Header } from './components/Header';

const API_BASE = '/api';

function App() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ws, setWs] = useState(null);

  useEffect(() => {
    fetchJobs();
    connectWebSocket();

    // Poll for updates every 5 seconds as fallback
    const interval = setInterval(fetchJobs, 5000);

    return () => {
      clearInterval(interval);
      if (ws) {
        ws.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const websocket = new WebSocket(wsUrl);

    websocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status_update') {
        // Refresh jobs when status updates
        fetchJobs();
      }
    };

    websocket.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    websocket.onclose = () => {
      // Reconnect after 3 seconds
      setTimeout(connectWebSocket, 3000);
    };

    setWs(websocket);
  };

  const fetchJobs = async () => {
    try {
      const response = await axios.get(`${API_BASE}/status`);
      setJobs(response.data);
    } catch (error) {
      console.error('Error fetching jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleNewCrawl = async (websites, maxDepth, maxPages, useSitemap = false, checkRedirectDuplicates = false) => {
    try {
      const response = await axios.post(`${API_BASE}/crawl`, {
        websites,
        maxDepth,
        maxPages,
        useSitemap,
        checkRedirectDuplicates,
      });
      
      // Refresh jobs list
      await fetchJobs();
      
      return response.data;
    } catch (error) {
      console.error('Error starting crawl:', error);
      throw error;
    }
  };

  const handleDeleteJob = async (jobId) => {
    try {
      await axios.delete(`${API_BASE}/crawl/${jobId}`);
      // Refresh jobs list
      await fetchJobs();
    } catch (error) {
      console.error('Error deleting job:', error);
      alert(error.response?.data?.error || 'Failed to delete job');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container px-4 md:px-6 py-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <NewCrawlForm onSubmit={handleNewCrawl} />
          <CrawlDashboard jobs={jobs} onRefresh={fetchJobs} onDelete={handleDeleteJob} />
        </div>
      </main>
    </div>
  );
}

export default App;

