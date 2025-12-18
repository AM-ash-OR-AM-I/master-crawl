# 🚀 Quick Start Guide

## Prerequisites

- Docker & Docker Compose installed
- OpenAI API Key

## 1. Clone and Setup

```bash
git clone <your-repo>
cd master-crawl
```

## 2. Configure Environment

Create a `.env` file:

```bash
cp env.example .env
```

Edit `.env` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-key-here
```

## 3. Start with Docker

```bash
docker-compose up -d
```

This will start:
- PostgreSQL (port 5432)
- Redis (port 6379)
- Backend API (port 3001)
- Frontend (port 3000)

## 4. Access the Application

Open your browser to: **http://localhost:3000**

## 5. Start Your First Crawl

1. Enter a website URL (e.g., `https://example.com`)
2. Set max depth (default: 3)
3. Set max pages (default: 500)
4. Click "Start Crawl"

## 6. Monitor Progress

- Watch the dashboard table for real-time updates
- Click "View" on any job to see details
- Check the "AI Recommendations" tab once analysis completes

## Troubleshooting

### Check Service Status

```bash
docker-compose ps
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f frontend
```

### Restart Services

```bash
docker-compose restart
```

### Stop Everything

```bash
docker-compose down
```

### Clean Start (removes data)

```bash
docker-compose down -v
docker-compose up -d
```

## Development Mode

For local development without Docker:

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Start PostgreSQL and Redis (using Docker)
docker-compose up -d postgres redis

# Start backend and frontend
npm run dev
```

## Next Steps

- Read the full [README.md](README.md) for detailed documentation
- Configure rate limits and cost controls for production
- Add authentication if needed
- Set up monitoring and logging

