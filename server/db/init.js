const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sitemap_generator',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err);
});

async function initDatabase() {
  try {
    // Read and execute schema
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    await pool.query(schema);
    console.log('✅ Database schema initialized');
    
    return pool;
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

module.exports = { pool, initDatabase };

