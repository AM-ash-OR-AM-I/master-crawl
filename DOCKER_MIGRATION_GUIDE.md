# Docker Migration Guide

This guide explains how to run database migrations when using Docker.

## Quick Start

### Option 1: Run migrations manually (Recommended)
```bash
# After containers are running
npm run docker:migrate

# Or check status
npm run docker:migrate:status
```

### Option 2: Run migrations automatically on startup
```bash
# Set environment variable
RUN_MIGRATIONS=true docker-compose up -d
```

### Option 3: Run migrations in a standalone container
```bash
npm run docker:migrate:standalone
```

## Detailed Options

### Option 1: Manual Migration (Recommended for Production)

**Step 1:** Start your containers
```bash
docker-compose up -d
```

**Step 2:** Run migrations
```bash
# Using npm script
npm run docker:migrate

# Or directly
docker-compose exec backend node server/db/migrate.js run
```

**Step 3:** Check status
```bash
npm run docker:migrate:status
```

**Pros:**
- ✅ Full control over when migrations run
- ✅ Can review migration output
- ✅ Safe for production deployments
- ✅ Can run migrations before starting the app

**Cons:**
- ❌ Requires manual step

### Option 2: Automatic Migration on Startup

**Enable automatic migrations:**
```bash
# Set environment variable in docker-compose.yml or .env
RUN_MIGRATIONS=true docker-compose up -d

# Or add to your .env file:
RUN_MIGRATIONS=true
```

**How it works:**
- The backend service checks `RUN_MIGRATIONS` environment variable
- If `true`, runs migrations before starting the server
- If `false` or unset, uses legacy schema initialization

**Pros:**
- ✅ Automatic - no manual step needed
- ✅ Migrations run before app starts
- ✅ Good for development

**Cons:**
- ❌ Less control
- ❌ Harder to debug if migrations fail
- ❌ Not recommended for production

### Option 3: Standalone Migration Container

**Run migrations in a separate container:**
```bash
npm run docker:migrate:standalone
```

This uses a separate `migrate` service defined in `docker-compose.migrate.yml`.

**Pros:**
- ✅ Clean separation
- ✅ Doesn't require backend to be running
- ✅ Can run migrations independently

**Cons:**
- ❌ Requires additional compose file

## Production Deployment Workflow

### Recommended Production Workflow:

1. **Deploy new code:**
   ```bash
   docker-compose build backend
   ```

2. **Run migrations:**
   ```bash
   docker-compose exec backend node server/db/migrate.js run
   ```

3. **Restart services:**
   ```bash
   docker-compose restart backend
   ```

### Alternative: Zero-Downtime Deployment

1. **Start new backend container (with old code):**
   ```bash
   docker-compose up -d --no-deps backend
   ```

2. **Run migrations:**
   ```bash
   docker-compose exec backend node server/db/migrate.js run
   ```

3. **Update backend with new code:**
   ```bash
   docker-compose build backend
   docker-compose up -d backend
   ```

## Troubleshooting

### Migration fails with connection error

**Problem:** Can't connect to database

**Solution:**
```bash
# Check if postgres is healthy
docker-compose ps postgres

# Check database connection
docker-compose exec backend node -e "const {pool} = require('./server/db/init'); pool.query('SELECT 1').then(() => console.log('OK')).catch(e => console.error(e));"
```

### Migration already applied error

**Problem:** Migration shows as already applied but you want to re-run

**Solution:**
```bash
# Check what's applied
docker-compose exec backend node server/db/migrate.js status

# If needed, manually remove from tracking (⚠️ DANGEROUS - only in dev)
docker-compose exec postgres psql -U postgres -d sitemap_generator -c "DELETE FROM schema_migrations WHERE migration_name = '004_your_migration.sql';"
```

### Can't find migration files

**Problem:** Migration files not found in container

**Solution:**
- Ensure `./server` is mounted as volume in docker-compose.yml
- Check that migration files exist in `server/db/migrations/`
- Rebuild container: `docker-compose build backend`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUN_MIGRATIONS` | `false` | If `true`, runs migrations on backend startup |
| `DB_HOST` | `postgres` | Database host (use service name in Docker) |
| `DB_PORT` | `5432` | Database port |
| `DB_NAME` | `sitemap_generator` | Database name |
| `DB_USER` | `postgres` | Database user |
| `DB_PASSWORD` | `postgres` | Database password |

## Best Practices

1. **Always check migration status before deploying:**
   ```bash
   npm run docker:migrate:status
   ```

2. **Run migrations in a separate step from deployment:**
   - Deploy code first
   - Run migrations
   - Restart services

3. **Test migrations on staging first:**
   - Never run untested migrations on production
   - Always have a rollback plan

4. **Use manual migrations in production:**
   - Automatic migrations are convenient but less safe
   - Manual control is better for production

5. **Monitor migration output:**
   - Check logs: `docker-compose logs backend`
   - Verify in database after migration

## Examples

### Development Setup
```bash
# Start everything with auto-migrations
RUN_MIGRATIONS=true docker-compose up -d
```

### Production Deployment
```bash
# 1. Pull/build new code
docker-compose build backend

# 2. Run migrations
docker-compose exec backend node server/db/migrate.js run

# 3. Restart with new code
docker-compose up -d backend
```

### Check What Needs Migration
```bash
docker-compose exec backend node server/db/migrate.js status
```
