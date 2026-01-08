const { pool, queryWithRetry } = require('./init');
const fs = require('fs');
const path = require('path');

/**
 * Run database migrations
 */
async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  
  // Ensure migrations table exists (should be created by 001_initial_schema.sql, but check anyway)
  try {
    await queryWithRetry(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        migration_name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await queryWithRetry(`
      CREATE INDEX IF NOT EXISTS idx_schema_migrations_name ON schema_migrations(migration_name)
    `);
  } catch (error) {
    // If table creation fails, it might already exist or be created by first migration
    // Continue anyway - the first migration will create it
    console.warn('Note: Migrations table check:', error.message);
  }

  // Get list of migration files
  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort(); // Sort alphabetically to ensure order

  console.log(`Found ${files.length} migration file(s)`);

  // Get already applied migrations
  const appliedResult = await queryWithRetry(
    'SELECT migration_name FROM schema_migrations ORDER BY migration_name'
  );
  const appliedMigrations = new Set(
    appliedResult.rows.map(row => row.migration_name)
  );

  // Apply each migration
  for (const file of files) {
    const migrationName = file;
    
    if (appliedMigrations.has(migrationName)) {
      console.log(`⏭️  Skipping ${migrationName} (already applied)`);
      continue;
    }

    console.log(`🔄 Applying migration: ${migrationName}`);

    try {
      const migrationPath = path.join(migrationsDir, file);
      const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

      // Start transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Execute migration
        await client.query(migrationSQL);

        // Record migration
        await client.query(
          'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
          [migrationName]
        );

        await client.query('COMMIT');
        console.log(`✅ Applied migration: ${migrationName}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`❌ Failed to apply migration ${migrationName}:`, error.message);
      throw error;
    }
  }

  console.log('✅ All migrations completed');
}

/**
 * Get migration status
 */
async function getMigrationStatus() {
  try {
    const appliedResult = await queryWithRetry(
      'SELECT migration_name, applied_at FROM schema_migrations ORDER BY migration_name'
    );
    
    const migrationsDir = path.join(__dirname, 'migrations');
    const allFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    const appliedSet = new Set(
      appliedResult.rows.map(row => row.migration_name)
    );

    console.log('\n📊 Migration Status:');
    console.log('─'.repeat(60));
    
    for (const file of allFiles) {
      const isApplied = appliedSet.has(file);
      const appliedInfo = appliedResult.rows.find(r => r.migration_name === file);
      const status = isApplied ? '✅ Applied' : '⏳ Pending';
      const date = appliedInfo ? ` (${appliedInfo.applied_at})` : '';
      console.log(`${status} - ${file}${date}`);
    }
    
    console.log('─'.repeat(60));
    console.log(`Total: ${allFiles.length} migrations, ${appliedResult.rows.length} applied`);
  } catch (error) {
    console.error('Failed to get migration status:', error);
    throw error;
  }
}

// CLI support
if (require.main === module) {
  const command = process.argv[2] || 'run';

  (async () => {
    try {
      if (command === 'run') {
        await runMigrations();
      } else if (command === 'status') {
        await getMigrationStatus();
      } else {
        console.log('Usage: node migrate.js [run|status]');
        process.exit(1);
      }
      process.exit(0);
    } catch (error) {
      console.error('Migration error:', error);
      process.exit(1);
    }
  })();
}

module.exports = { runMigrations, getMigrationStatus };
