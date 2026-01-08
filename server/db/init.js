const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sitemap_generator',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: parseInt(process.env.DB_POOL_MAX || '50'), // Increased for concurrent crawling
  idleTimeoutMillis: 60000, // 60 seconds
  connectionTimeoutMillis: 15000, // Increased from 2s to 15s
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

/**
 * Execute a query with retry logic for connection timeouts
 */
async function queryWithRetry(text, params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await pool.query(text, params);
    } catch (error) {
      const isConnectionError = 
        error.message.includes('connection timeout') ||
        error.message.includes('Connection terminated') ||
        error.message.includes('Connection terminated unexpectedly') ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT';
      
      if (isConnectionError && i < retries - 1) {
        const delay = Math.min(1000 * Math.pow(2, i), 5000); // Exponential backoff, max 5s
        console.warn(`⚠️ Database connection error (attempt ${i + 1}/${retries}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function initDatabase(runMigrations = false) {
  try {
    if (runMigrations) {
      // Use migration system
      const { runMigrations: executeMigrations } = require('./migrate');
      await executeMigrations();
      console.log('✅ Database migrations completed');
      return pool;
    } else {
      // Legacy: Read and execute schema.sql (for backward compatibility)
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      
      await pool.query(schema);
      console.log('✅ Database schema initialized');
      
      return pool;
    }
  } catch (error) {
    // If tables already exist, that's okay
    if (error.code === '42P07' || error.code === '42710') {
      console.log('✅ Database schema already exists');
      return pool;
    }
    // Log other errors but don't fail - schema might be partially created
    console.warn('⚠️ Database initialization warning:', error.message);
    if (error.code && !['42P07', '42710', '42P16'].includes(error.code)) {
      throw error;
    }
    return pool;
  }
}

module.exports = { pool, initDatabase, queryWithRetry };

