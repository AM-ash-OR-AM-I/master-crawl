# Database Migrations

This directory contains SQL migration files that are applied in order to update the database schema.

## How It Works

1. Migration files are named with a number prefix (e.g., `001_initial_schema.sql`) to ensure execution order
2. Each migration is tracked in the `schema_migrations` table
3. Migrations are applied automatically or can be run manually

## Running Migrations

### Run all pending migrations

```bash
npm run migrate
```

### Check migration status

```bash
npm run migrate:status
```

### Run migrations programmatically

```javascript
const { runMigrations } = require('./server/db/migrate');
await runMigrations();
```

## Creating New Migrations

1. Create a new SQL file in this directory with the next sequential number:
   - `004_your_migration_name.sql`
   - `005_another_migration.sql`
   - etc.

2. Write your migration SQL. Use `IF NOT EXISTS` clauses where appropriate to make migrations idempotent:

   ```sql
   -- Migration: 004_add_new_column.sql
   -- Description: Add new column to pages table
   
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

3. Test the migration:

   ```bash
   npm run migrate:status  # Check current status
   npm run migrate         # Apply new migration
   ```

## Migration Best Practices

1. **Always use transactions** - The migration runner wraps each migration in a transaction
2. **Make migrations idempotent** - Use `IF NOT EXISTS` checks so migrations can be safely re-run
3. **Never modify existing migrations** - Once applied, create a new migration to fix issues
4. **Test on a copy of production data** - Always test migrations before applying to production
5. **Add comments** - Document what each migration does and why

## Migration Files

- `001_initial_schema.sql` - Creates migrations table and initial database schema
- `002_add_original_href.sql` - Adds original_href column to pages table

## Troubleshooting

If a migration fails:

1. Check the error message in the console
2. The migration will be rolled back automatically
3. Fix the migration SQL and try again
4. If needed, manually remove the failed migration record from `schema_migrations` table
