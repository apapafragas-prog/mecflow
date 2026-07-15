# MECflow / CBRE Reporting — Project Notes

Context file so any Claude session (local or cloud, any PC) can pick up the project instantly.

## What it is
Internal CBRE Hellas reporting app: invoice scanning (AP = supplier costs, AR = client revenue),
P&L per client, Excel export. React (Vite) frontend + Node backend + SQLite, runs in Docker on a Synology NAS.

## Structure
- `frontend/src/App.jsx` — App shell: auth gate, session/save orchestration, tab routing, header/nav (~770 lines).
  The old monolith was split (L-05) into focused modules under `frontend/src/`:
  - `constants.js` (domain data, palette, MONTHS/ML, small helpers), `calc.js` (pure calc helpers, unit-tested)
  - `ui.jsx` (leaf components: LogoImg, PwField, MdText, Inp, Sel, Tbl), `api.js` (API client)
  - `auth.jsx` (Login/ForcePw/ResetPassword), `clientPicker.jsx` (landing), `contracts.jsx` (ContractTab)
  - `scan.jsx` (invoice/doc scanner + AI extraction), `reportTabs.jsx` (PnL/InvTab/SubTab/AccTab/LabTab/POTracker)
  - `insights.jsx` (AiCard + Insights), `chat.jsx` (ChatWidget + snapshot builders)
  - `finance.jsx` (Dashboard/ApArLedger/OpexCapex), `admin.jsx` (AdminPanel)
  - Safety net: ESLint `no-undef` (CI) catches any missing import when moving code between modules.
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

## Section 07 improvements + remaining cleanups (2026-07) — DONE
- Email notifications (Zoho SMTP) on report status: submit → finance/admin, approve/reject →
  submitter (with reject reason). Fired from PUT /api/data only on a real status transition.
- Portfolio Dashboard ("📊 Dashboard", all roles): loads all clients via getYearData →
  real KPIs, monthly revenue/GM trend, completeness breakdown, pending-approvals inbox,
  expiring-contracts (≤90d) list, top-clients-by-GM. GM = rev − sub − labour.
- Contract expiry alerts (L-06): parseDate/daysUntil; badge on contract cards + dashboard list.
- Import Excel: Merge vs Replace choice with a parsed-counts preview (was silent replace) — BUG-09.
- DB backup: admin "⬇ Backup βάσης" → GET /api/backup (WAL checkpoint + stream cbre.db).
- Cleanups: removed dead `acc` blob (L-01), dead python files (L-02), CORS credentials (L-08).
- Frontend tests (L-07): pure calc helpers extracted to frontend/src/calc.js + vitest suite
  (12 tests) + CI step. Run: `cd frontend && npm test`.

### Deliberately NOT done (large / low value — flagged for the user):
- L-04 global mutable MONTHS → React state (large architectural change; works today). Deferred — low value, risky.
- L-05 split the App.jsx monolith into components — ✅ DONE (2026-07). App.jsx ~770 lines; feature code in modules above.
- Self-hosted logos: left as-is (already degrades gracefully to colored initials on error).

## AI Analytics & Forecasting (2026-07) — DONE
Hybrid: deterministic forecast/risk flags + on-demand Claude narrative (aggregated numbers only).
- calc.js: clientSeries, linregSlope, runRateFY (run-rate annualization), clientRisks
  (low GM / negative GM / falling GM / cost spike / expiring contract / PO over-budget).
  Unit-tested in calc.test.js (now 16 tests total).
- Backend: POST /api/insights (auth + rate-limited) — sends ONLY aggregated numbers to Claude
  (model claude-sonnet-4-6), returns Greek commentary. 503 if ANTHROPIC_API_KEY unset.
- Per-client "📈 Insights" tab: projected-FY KPIs (actual vs run-rate), monthly GM trend,
  risk flags, and an "AI σχολιασμός" card (on-demand button → /api/insights).
- Portfolio: dashboard gains projected-FY tiles, a clients-at-risk list, and a portfolio
  AI-summary card. AiCard component is shared by both scopes.
- Privacy: only aggregated monthly/total figures + risk labels are sent to the AI — never raw invoices.

## ERP — AP/AR Ledger + Aging (2026-07) — DONE (first ERP piece)
- Payment tracking: new `paid` field ("paid"/"") + `paid_date` on inv/sub rows. Editable
  "Πληρωμή" column added to CBRE Invoices and Sub Invoices tabs (no schema change — plain data).
- calc.js: agingBucket(invoiceDate, termsDays) → current/1-30/31-60/61-90/90+ (unit-tested; 17 total).
- ApArLedger view ("📒 AP/AR" button on client picker, finance/admin): loads all clients via
  getYearData. AR = client invoices (receivable), AP = supplier sub invoices (payable). UI terms
  selector (Net 30 / Net 60 / from invoice date). KPIs (open, overdue), aging-bucket tiles,
  per-counterparty aging table, and an open-items list with a "Paid/Unpay" toggle.
- Mark-paid writes back safely: getClientData (fresh + version) → set paid → saveClientData with
  optimistic locking, then updates the local snapshot.
- No backend changes — reuses existing data endpoints.

## AI Chat assistant (2026-07) — DONE
Metron-style: single-shot Anthropic call with a client-built snapshot (NOT live tool-calling).
- Frontend `ChatWidget` (floating 🤖 FAB → panel), mounted on every authenticated screen via a
  `withChat()` wrapper in App. localStorage history (cap 30, last 9 sent), context-aware suggestion
  chips, XSS-safe mini-markdown, and clickable action chips that navigate (nav vocabulary:
  dashboard | ledger | opex | tab:<id> | client:<name>:<tab>).
- Snapshot builders (App.jsx): buildClientSnapshot (from the loaded cd) and buildPortfolioSnapshot
  (fetches getYearData once, cached — access-filtered server-side). ~2-3KB, aggregated only.
- Backend POST /api/chat: auth-gated, rate-limited (40/10min/IP), daily circuit-breaker
  (CHAT_DAILY_CAP env, default 2000), single Anthropic call (claude-sonnet-4-6) with a strict-JSON
  system prompt, defensive JSON parse (falls back to raw text). 503 if no key.
- Available to ALL staff; snapshot is already permission-scoped. CHAT_DAILY_CAP added to compose.

### Still proposed (not started): myDATA/ΑΑΔΕ bridge (needs AADE credentials), Vendor/Customer
### master, GL/chart-of-accounts. See audit report artifact.
