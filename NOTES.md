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

## Audit fixes — Phase B (2026-07, branch claude/mecflow-access-cu32g6)
Full platform audit done; these were fixed and are safe to deploy:
- **BUG-01** Excel export used a fixed `×24%` formula for VAT → now exports the REAL stored VAT
  (correct for 13/6/0% invoices). Header label "VAT (24%)" → "VAT".
- **BUG-03** `crypto.randomUUID()` throws over plain http (LAN IP) → new `uid()` helper with fallback.
- **BUG-05** P&L export title was hardcoded "GREECE FY26" → now uses the selected FY.
- **BUG-04** Admin console added (⚙️ Admin button on the client picker, role=admin only):
  user management (list/create/delete) + audit-log viewer. Backend endpoints already existed.
- **BUG-06** Removed JWT-in-URL (`?token=`) fallback from file download (leaks in logs/history).
- **BUG-07** Login rate-limit now keyed by username+IP (was bare IP → whole office shared one NAT IP).
- **BUG-08** Added `PATCH /api/files/:year/:client/:id` (api.updateFileRef called a route that didn't exist).
- **BUG-10** Unknown `/api/*` routes now return JSON 404 instead of index.html.
- Added a **reject reason** field: Finance is prompted for a reason on Reject; ops sees it as a banner.
- Verified: backend `npm test` 9/9 green, `vite build` clean.

### PENDING — need a finance decision before changing (NOT touched yet):
- **BUG-02** All labour is subtracted from FM Core only (`lc_ew`/`lc_pjm` hardcoded 0), so the
  per-segment GM (Core vs Extra vs PJM) is misallocated. Total GM is correct. Fix needs either a
  per-segment labour split in the Labour tab, or confirmation that all labour belongs to Core.
- **UBR/UER** split in Accruals is done purely by the sign of the amount — confirm with accounting.

### Bigger modules proposed (not started): OPEX/CAPEX section, AI analytics/forecasting, ERP/myDATA.
See the audit report artifact for the full roadmap.
