require('dotenv').config();
const express = require('express');
const cors = require('cors');
const expressWs = require('express-ws');
const { createServer } = require('http');

const { initDatabase } = require('./db/init');
const { initQueue } = require('./queue/queue');
const crawlRoutes = require('./routes/crawl');
const statusRoutes = require('./routes/status');
const { setupWebSocket } = require('./websocket/websocket');

const app = express();
const server = createServer(app);
expressWs(app, server);

const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/crawl', crawlRoutes);
app.use('/api/status', statusRoutes);

// WebSocket setup
setupWebSocket(app);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize database and queue
async function start() {
  try {
    // Run migrations if enabled (set RUN_MIGRATIONS=true in environment)
    if (process.env.RUN_MIGRATIONS === 'true') {
      const { runMigrations } = require('./db/migrate');
      console.log('🔄 Running database migrations...');
      await runMigrations();
    } else {
      // Use legacy schema initialization
      await initDatabase();
    }
    
    await initQueue();
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 WebSocket ready for real-time updates`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();

