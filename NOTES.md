# MECflow / CBRE Reporting — Project Notes

Context file so any Claude session (local or cloud, any PC) can pick up the project instantly.

## What it is
Internal CBRE Hellas reporting app: invoice scanning (AP = supplier costs, AR = client revenue),
P&L per client, Excel export. React (Vite) frontend + Node backend + SQLite, runs in Docker on a Synology NAS.

## Structure
- `frontend/src/App.jsx` — the whole React app (monolith). The invoice scanner is the `Scan()` component.
- `backend/server.js` — API + Claude Vision invoice extraction (`POST /api/extract/invoice`). Prompt + validation live here.
- `backend/init-db.js`, `backend/excel_report.py` — DB init, Excel report helper.
- Root `Dockerfile`, `docker-compose.yml` (port 3300:3000, volume `./data:/data`).

## Deploy (to the NAS — local network only)
Source on the NAS: `/volume1/docker/cbre` (SSH `papafra@192.168.1.158 -p 2222`; scp uses `-O -P 2222`).
After updating the NAS source, ALWAYS run:
```
cd /volume1/docker/cbre && sudo docker-compose build --no-cache && sudo docker-compose down && sudo docker-compose up -d
```
A cached build does NOT reliably pick up frontend changes. Verify: `curl http://localhost:3300/ | grep -o 'index-[A-Za-z0-9_-]*.js'`.
NOTE: the NAS is on the home LAN — a **cloud** Claude session cannot reach it; run deploys from a machine on that network.

## Key business rule — invoice direction (AP vs AR)
- **AR** (revenue -> CBRE Invoices): ONLY when the ISSUER is **CBRE Hellas** ("CBRE Hellas Μονοπροσωπή ΑΕ" / "Single Member SA").
- **AP** (cost -> Sub Invoices): every other issuer, **including ATRIA** and all vendors/subcontractors.

## Scanner
Single-file mode (manual AP/AR toggle) + **bulk folder mode** (folder button) with per-invoice **AUTO AP/AR
detection** (Claude returns `direction`). Each result card has an editable AP/AR badge (click to flip).

## Git / working from any PC
- This repo (`apapafragas-prog/mecflow`) is the source of truth. Work in the clone; `git pull` at start, `git commit` + `git push` at end.
- Auto-sync: run `setup-autosync.ps1` once per PC — installs a scheduled task that pulls+commits+pushes every 15 min.
- NEVER commit secrets: `.env`, `data/`, `*.db`, `backups/` (already in `.gitignore`).

## Recent work (2026-06)
- Fixed P&L Excel export GM formulas (labour now subtracted; per-segment GM correct).
- Added bulk-folder scan with automatic AP/AR routing.
- Set up GitHub sync + per-PC auto-sync automation.
