# CBRE Hellas Reporting Platform

Self-hosted deployment for Synology DS923+ with remote access.

## Quick Start

1. **Read** `SETUP.md` for full step-by-step instructions
2. **Upload** the entire folder to `/docker/cbre/` on your NAS (via File Station)
3. **Configure** `.env` (copy `.env.example` and edit `JWT_SECRET`, `CORS_ORIGIN`)
4. **Build & start** via Container Manager → Project → Create
5. **Access** at `https://your-ddns.synology.me`

## Default Users

All passwords: `ChangeMe!2026` (change on first login!)

| Username | Role | Access |
|----------|------|--------|
| antonis | admin | All clients |
| manos | finance | All clients (approve/reject) |
| kostas | ops | Pharma & FMCG portfolio |
| omiros | ops | Tech & Banking portfolio |
| iro | ops | Logistics portfolio |

## Architecture

- **Backend**: Node.js + Express + SQLite + JWT
- **Frontend**: React + Vite (built into static)
- **Storage**: `/docker/cbre/data/` (SQLite DB + uploaded files)
- **Deployment**: Single Docker container

## Files

```
cbre-deploy/
├── Dockerfile              # Multi-stage build
├── docker-compose.yml      # Container config
├── .env.example            # Environment template
├── SETUP.md                # Detailed setup guide
├── README.md               # This file
├── backend/
│   ├── package.json
│   ├── server.js           # Express API
│   └── init-db.js          # DB initialization
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx         # Main React app (CBRE Reporting)
        └── api.js          # API client
```

## Maintenance

- **Backups**: `/docker/cbre/data/` via Hyper Backup
- **Updates**: Replace `App.jsx` → rebuild container
- **Logs**: Container Manager → cbre-reporting → Log
- **Audit**: Admin can view all user actions via API

See SETUP.md for everything else.
