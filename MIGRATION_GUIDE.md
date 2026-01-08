# Database Migration Guide

## Quick Start

### Run migrations manually:
```bash
npm run migrate
```

### Check migration status:
```bash
npm run migrate:status
```

## Migration System Overview

The project now uses a proper migration system to manage database schema changes. This ensures:
- **Version control** - All schema changes are tracked
- **Reproducibility** - Same migrations can be applied to any environment
- **Safety** - Migrations are transactional and can be rolled back
- **History** - Track when and what changes were applied

## Migration Files Location

All migration files are in: `server/db/migrations/`

## Creating a New Migration

1. **Create a new migration file** with the next sequential number:
   ```bash
   # Example: server/db/migrations/004_add_new_feature.sql
   ```

2. **Write your migration SQL**:
   ```sql
   -- Migration: 004_add_new_feature.sql
   -- Description: Add new feature column
   -- Created: 2024-01-15
   
   DO $$ 
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns 
       WHERE table_name = 'pages' AND column_name = 'new_feature'
     ) THEN
       ALTER TABLE pages ADD COLUMN new_feature TEXT;
     END IF;
   END $$;
   ```

3. **Run the migration**:
   ```bash
   npm run migrate
   ```

## Migration Best Practices

### ✅ DO:
- Use `IF NOT EXISTS` checks to make migrations idempotent
- Test migrations on a copy of production data first
- Add descriptive comments explaining what and why
- Use transactions (automatic in the migration runner)
- Number migrations sequentially

### ❌ DON'T:
- Modify existing migration files after they've been applied
- Delete migration files
- Skip migration numbers
- Make breaking changes without a plan

## Common Migration Patterns

### Adding a Column
```sql
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'pages' AND column_name = 'new_column'
  ) THEN
    ALTER TABLE pages ADD COLUMN new_column TEXT;
  END IF;
END $$;
```

### Adding an Index
```sql
CREATE INDEX IF NOT EXISTS idx_pages_new_column ON pages(new_column);
```

### Adding a Table
```sql
CREATE TABLE IF NOT EXISTS new_table (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### Modifying a Column
```sql
-- Note: PostgreSQL has limited ALTER COLUMN support
-- For complex changes, you may need to:
-- 1. Add new column
-- 2. Migrate data
-- 3. Drop old column
-- 4. Rename new column
```

## Troubleshooting

### Migration Fails
1. Check the error message - it will tell you what went wrong
2. The migration is automatically rolled back
3. Fix the SQL and try again
4. If needed, manually remove the failed migration from `schema_migrations`:
   ```sql
   DELETE FROM schema_migrations WHERE migration_name = '004_failed_migration.sql';
   ```

### Check What's Applied
```bash
npm run migrate:status
```

### Reset Migrations (⚠️ DANGEROUS - Only for development)
```sql
-- Only do this in development!
TRUNCATE TABLE schema_migrations;
```

## Integration with Application

The migration system can be integrated into your application startup:

```javascript
// In server/index.js or similar
const { initDatabase } = require('./db/init');
const { runMigrations } = require('./db/migrate');

// Option 1: Run migrations automatically on startup
await runMigrations();
await initDatabase();

// Option 2: Use initDatabase with migration flag
await initDatabase(true); // true = use migrations
```

## Environment-Specific Considerations

### Development
- Run migrations manually: `npm run migrate`
- Or set up auto-migration on startup

### Production
- Always run migrations manually before deployment
- Test migrations on staging first
- Have a rollback plan
- Consider maintenance windows for large migrations

## Current Migrations

1. **001_initial_schema.sql** - Creates migrations table, all base tables and indexes
2. **002_add_original_href.sql** - Adds original_href column to pages table

## Legacy Schema Support

The old `schema.sql` file is still supported for backward compatibility. However, new changes should use the migration system.
