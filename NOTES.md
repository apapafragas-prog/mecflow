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
As of 2026-07 the NAS folder IS a git clone of this repo (origin = apapafragas-prog/mecflow),
so deploy is just pull + rebuild — no more scp:
```
cd /volume1/docker/cbre && git pull && sudo docker-compose build --no-cache && sudo docker-compose down && sudo docker-compose up -d
```
`.env`, `data/` (cbre.db + files), and `backups/` are gitignored → never touched by pull.
A cached build does NOT reliably pick up frontend changes (hence --no-cache). Verify healthy:
`sudo docker-compose ps` (Up healthy) and `sudo docker-compose logs --tail=25 cbre`.
NOTE: the NAS is on the home LAN — a **cloud** Claude session cannot reach it; run deploys from
the NAS shell (or a machine on that network). Pushing to the branch is done from the cloud session.

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

### Resolved after finance sign-off:
- **BUG-02 DONE** — labour is now split across segments. New per-month allocation (`labAlloc`,
  weights core/ew/pjm) in the Labour tab; default 100% Core keeps existing numbers unchanged.
  Allocation is proportional so total labour & total GM are ALWAYS preserved — only the
  per-segment GM (Core/Extra/PJM) becomes correct. Applied to P&L screen, drill-down and Excel
  export (P&L sheet now has 3 labour lines; GM formulas subtract the matching segment's labour).
- **UBR/UER** sign-based split confirmed correct by finance — no change.

## OPEX / CAPEX module (2026-07) — DONE
Company-wide (not per-client) OPEX/CAPEX section for finance+admin.
- Backend: new `finance_data` table (one JSON blob per FY), `GET/PUT /api/finance/:year`
  gated by requireRole("finance","admin"), optimistic locking (409) like client_data.
- Frontend: `OpexCapex` full-screen view, opened via a "💰 OPEX/CAPEX" button on the client
  picker (finance/admin only). Three sub-tabs:
  - OPEX: editable category grid × months with an Actual / Budget / Variance toggle (variance =
    actual−budget, red = over budget). Categories are add/rename/delete.
  - CAPEX: register (desc, category, value, acquisition month, useful life, status, PO) with
    straight-line depreciation columns computed live (monthly, accumulated-to-FY-end, NBV).
  - Summary: KPI tiles + OPEX budget-vs-actual per category.
- Blob shape: { opex:{cats:[{id,label}], budget:{catId:{month:n}}, actual:{...}}, capex:[{id,desc,cat,amount,month,life,status,po}] }.
- Verified: finance GET/PUT + 409 locking + ops 403; depreciation math unit-checked; vite build clean.

### Still proposed (not started): AI analytics/forecasting, ERP/myDATA. See audit report artifact.
