# MECflow SaaS — Implementation Handoff & Feature Spec

> **Purpose.** This document is a build spec for the **MECflow SaaS** codebase (multi-tenant,
> brand-neutral). It captures *everything* we designed, fixed, and shipped in the CBRE-specific
> MECflow build so you can reproduce it — **and do it as well or better** — in the SaaS product.
>
> **Golden rule for the SaaS:** wherever the CBRE build hardcodes brand/tenant specifics
> (green `#003F2D`, the CBRE logo SVG, the fixed client roster, the CBRE company name), the SaaS
> must read them from **per-tenant configuration** (theme tokens + uploaded logo + tenant-managed
> client list). Every data row must be scoped by `tenant_id`. See §2.
>
> Γρήγορη περίληψη (EL): Αυτό το αρχείο περιγράφει όλα τα restyle, τα bug fixes, και τις νέες
> λειτουργίες που φτιάξαμε, ώστε το MECflow SaaS να τα υλοποιήσει ίδια ή καλύτερα, αλλά brand-neutral
> και multi-tenant.

---

## 1. Product & architecture baseline

MECflow is a monthly **financial reporting platform for facility-management / cost-plus service
companies**. Per client: invoices (revenue), subcontractor bills (cost), labour, accruals, contracts/POs,
uploaded documents. Company-wide: OPEX/CAPEX, consolidated P&L, Balance Sheet, Cash Flow, AP/AR ledger,
month-end close (MEC), AI insights/chat, an AI invoice scanner.

**Stack (reproduce or improve):**
- **Frontend:** React (Vite), plain `.jsx`, no CSS framework — inline styles driven by a shared palette
  token object `P`. ~20 modules. Bilingual i18n via a `t("Ελληνικά","English")` helper + `useT()`.
- **Backend:** Node/Express + **better-sqlite3** (single-file DB, WAL). JWT auth with `token_version`
  revocation. Per-entity JSON **blobs** with **optimistic locking** (client sends `{data, baseVersion}`,
  server returns `409` on version mismatch).
- **Data model:** two blob kinds —
  - **per-client blob** `client_data(year, client)` → `{inv, sub, lab, labAlloc, manualAccruals,
    contracts, docs, locked, status, submittedBy, submittedAt, labPlan, accrualReverse}`
  - **finance blob** `finance_data(year)` → `{opex:{cats,actual,budget}, capex[], pnl:{interest,tax},
    bs:{accounts,values}, budgets, close, cashOpening}` (finance/admin only)
- **Fiscal months** are derived from the selected FY (a `MONTHS`/`ML` array, mutated in place by
  `setFiscalYear`). A `normalizeClientData`/`remapMonth` layer **heals** month keys onto the active FY
  on every load path (critical — see §6.3).
- **Roles:** `ops` (data entry, own clients), `finance` (all clients + finance blob), `admin` (+ user mgmt).

**Key files (CBRE build) for reference:**
`frontend/src/`: `constants.js` (palette `P`, clients, `normalizeClientData`, `remapMonth`,
`remapFinanceMonths`, `fmt`), `calc.js` (pure math + tests), `ui.jsx` (shared components:
`AppHeader`, `HeaderBtn`, `CbreMark`, `Tbl`, `Inp`, `Sel`, `Skeleton`, `LangToggle`, `GlobalSearch`),
`App.jsx` (client screen + state/save engine), `finance.jsx` (`Dashboard`, `ApArLedger`, `OpexCapex`),
`groupReports.jsx` (consolidated P&L / BS / Cash / Fee&COP / MEC + Board Pack), `reportTabs.jsx`
(`InvTab`, `SubTab`, `AccTab`, `LabTab`, `PnL`), `clientPicker.jsx`, `auth.jsx`.
`backend/`: `server.js`, `init-db.js`, `lib/validate.js`, `scripts/smoke.sh`.

---

## 2. Multi-tenant / brand-neutral deltas (SaaS-only — do this first)

The CBRE build is single-tenant. For the SaaS:

1. **Tenants table** `tenants(id, name, slug, created_at)`. Every user, `client_data`, `finance_data`,
   `documents`, `audit_log`, `password_reset` row carries `tenant_id`. JWT payload includes `tenant_id`;
   **every** query and access check is scoped by it (defence-in-depth: never trust a client-supplied
   tenant). Add a DB unique index on `(tenant_id, year, client)` etc.
2. **Per-tenant branding/theme** `tenant_theme(tenant_id)` → `{ brand, brandDark, accent, logoSvg,
   logoWhiteSvg, negative, positive, fontStack }`. The frontend palette `P` (see §3.1) is **built from
   the tenant theme at runtime**, not hardcoded. Ship a sensible **neutral default theme** (a calm
   green/graphite works) so a new tenant looks good with zero setup.
3. **Logo** is a tenant-uploaded SVG (validated/sanitised). Replace the hardcoded `CbreMark` component
   with a generic `<BrandMark>` that renders the tenant's `logoSvg` (green/on-light) or `logoWhiteSvg`
   (on-dark). **Never render the company name typed in a font as the logo** (keep this rule generic:
   require an uploaded mark; fall back to the tenant name in the brand font only if no logo).
4. **Client roster is tenant-managed** — replace the fixed `CLIENTS` array + `LOGOS` map with a
   per-tenant `clients` table (name + optional logo domain for Clearbit-style favicons). Ops users are
   assigned a subset; finance/admin see all of their tenant.
5. **Tenant onboarding**: first admin user, theme setup wizard, seed empty FY blobs lazily.
6. **Plans/limits** (optional): per-tenant caps for AI usage, storage, users.
7. Keep the CBRE 2026 palette only as *one* selectable preset among defaults — not the baked-in identity.

Everything in §3–§10 below should be implemented **through** this tenant/theme layer.

---

## 3. Design system & full restyle (all screens)

Direction: **light, card-based, one brand accent used sparingly** — clean and finance-appropriate
(light theme reads best for dense tables, board packs, PDF/print). Reproduce this as a **token-driven
design system** (per-tenant theme, see §2.2). Dark mode optional but keep it token-based.

### 3.1 Palette tokens (`constants.js` → `P`)
A single flat token object consumed by every inline style. CBRE values shown; SaaS derives from theme:
```
P = {
  em: brand,          // primary (CBRE #003F2D) — headers, buttons, emphasis
  ep: brandPale,      // pale brand tint (#E8F5E9) — chips/pills bg
  wh: "#fff",         // surface
  of: groundNeutral,  // app background — slightly tinted toward the accent (#EEF2F0) so white cards separate
  bd: hairline,       // borders (#E1E7E3)
  tx: ink,            // text (#1A2E23)
  tm: muted,          // muted text (#5F7567)
  rd: negative,       // negatives / danger (#AD2A2A)  ← accounting-correct, not pure red
  gn: positive,       // positive (#2E7D32)
  al: altRow,         // zebra alt row (#F4F8F5)
  ip: inputBg,        // input background (#F5F8F6)
  ac: accent,         // ACCENT (#17E88F) — use sparingly: one highlighted bar, positive deltas
  dk: brandDarker,    // dark brand (#012A2D)
  sh: "0 1px 2px rgba(3,42,45,.04), 0 6px 18px rgba(3,42,45,.05)",  // shared soft card shadow
}
```
Rules: **accent only for highlights** (never large fills). Negatives in accounting style (parentheses via
`fmt(n)`), colour `rd`. All cards use `border:1px solid P.bd` + `borderRadius` + `boxShadow:P.sh`.

### 3.2 Shared header — `AppHeader` (`ui.jsx`)
Replace every screen's coloured top bar with ONE component. Signature:
`AppHeader({ user, onLogout, onBack, backLabel, title, sub, right })`.
Renders: a light surface bar (`P.sh`) with **the real brand logo** (SVG component — *not* typed text),
a monospace sub-label (default "…· Reporting"), an optional back pill, a title chip (`P.em`), then on the
right the caller's `right` slot (screen-specific pills), the language toggle, a **gradient avatar with the
user's initials**, and a logout pill. Also add `HeaderBtn({onClick,children,tone,active})` — the standard
pill nav control (light default / solid brand when active).
Apply to: client screen, Dashboard, AP/AR, OPEX/CAPEX, Group, and the landing/client-picker (its section
nav becomes `HeaderBtn` pills). **Tab bars become rounded pills** (active = filled brand pill), keeping
any drag-to-reorder.
Acceptance: identical header on every screen; brand logo is the tenant's uploaded SVG; no company name is
ever typed as a logo.

### 3.3 Hero cards
Every top-level financial screen leads with a **green (brand-gradient) hero card**: a mono eyebrow,
one big headline number, a one-line meta, and a subtle wave SVG. Reuse across:
- **Dashboard** → Consolidated Revenue YTD + YoY badge + active-clients + GM%.
- **Group P&L** → Consolidated Revenue YTD + EBITDA + margin.
- **AP/AR** → Open receivable/payable + overdue share.
- **OPEX/CAPEX** → Total OPEX actual + budget + variance%.

### 3.4 Charts (inline SVG, brand data-viz palette)
No chart library — hand-built inline SVG, responsive via `viewBox`, tooltips via `<title>`. Data-viz
palette (accessible, brand-neutral defaults): `["#80BBAD","#435254","#17E88F","#DBD99A","#D2785A",
"#885073","#A388BF","#1F3765","#3E7CA6","#CAD1D3"]`; negatives `#AD2A2A`.
Implement these reusable shapes:
- **Vertical bar chart + trend line** — Dashboard (Revenue bars, peak emphasised in brand, GM per-month
  + GM line) and Group P&L (Revenue bars + EBITDA line). Gridlines, month labels, tabular-nums.
- **Donut + inline legend** — AP/AR (aging buckets) and OPEX/CAPEX (spend by category, top-7 + "Other").
  Built with stacked `<circle>` + `stroke-dasharray`/`-dashoffset`, total in the centre.
- **Diverging bar chart** — 13-week cash forecast (collections up, payments down, cumulative-net line;
  see §9.2).

### 3.5 Mobile / responsive (global CSS in `index.html`)
- `input,select,textarea{font-size:16px !important}` at `≤640px` to stop iOS zoom-on-focus; **but**
  `table input{font-size:12px !important}` to keep dense grids compact (they scroll horizontally).
- `body{overflow-x:hidden}`; every wide table/diagram in its own `overflow-x:auto` container.
- Momentum scrolling on scroll containers; responsive side padding via `clamp(12px,4vw,24px)`.
- Headers/nav/toolbars use `flex-wrap:wrap`; KPI grids use `repeat(auto-fill,minmax(150px,1fr))`.

---

## 4. Features & upgrades to build (each is a full deliverable)

### 4.1 Board-ready Month-End Pack (P&L board summary)
On the consolidated P&L, a view toggle **Monthly grid ⇄ Board Summary**. Board Summary compares, per P&L
line, **Actual YTD vs Budget vs Prior-Year**, with variance €, variance %, and YoY %, coloured by
favourability (**cost rows inverted**). Budget is derived: revenue/GM from per-client annual targets
(`fin.budgets[client] = {rev, gmPct, feePct}`), OPEX budget from `fin.opex.budget`, EBITDA budget =
GM budget − OPEX budget. Prior-year series loaded alongside current (see §6.3 for the normalization bug).
Print-to-PDF export of the board pack.

### 4.2 Receivables / Collections (AP/AR ledger)
- **Partial payments**: each invoice/sub row carries `payments:[{date, amount}]`. A "record partial
  payment" modal appends a payment; the doc auto-closes when payments cover the total. **Aging, buckets,
  and per-counterparty totals compute on the remaining balance**, not the full amount (see `settlementInfo`
  §6.1). A Balance column + "partial" badge; Excel export includes Settled/Balance/Status.
- **Per-counterparty payment terms**: editable "Net X days" override per client/supplier, persisted
  (namespaced by AR vs AP so a client & supplier of the same name don't collide — §6.2 L3). Falls back to
  a global default. Aging uses the per-counterparty term where set.
- **DSO/DPO + 13-week cash forecast** — see §9.

### 4.3 Labour FTE × rate planner + auto accrual reversal
- **FTE planner** (Labour tab): per core labour category enter FTE + monthly rate → computed monthly cost;
  "Apply" fills every unlocked month; "Apply all". Inputs **persisted** in the client blob (`labPlan`).
- **Auto accrual reversal** (Accruals tab): a toggle where a manual accrual in month M is automatically
  negated in M+1 (the standard accrual/reversal pair), shown inline per cell and folded into totals.
  Toggle **persisted** (`accrualReverse`).

### 4.4 Bulk operations + undo (data tables)
`Tbl` gains an optional row-checkbox column (+ select-all), a **bulk-delete** toolbar, and an **8-second
undo toast** that restores deleted rows via an `onRestore(rows)` prop. Deleted rows are snapshotted with
`docId` stripped (attachments are purged and can't be un-deleted). Locked (closed-period) rows are
excluded from selection. Clear the undo timer on unmount.

### 4.5 Global search palette (⌘K / Ctrl-K)
A command-palette overlay: cross-client fuzzy search over clients, invoices, subcontractor bills, and
contracts for the active year (token-AND match, keyboard nav ↑↓/↵, jumps to the right client + tab).
Openable via ⌘K/Ctrl-K anywhere or a header search button. **Scoped to the data the user may see**
(§6.2 H4) — a restricted user must never see the full roster.

### 4.6 Consolidated Board Pack PDF — see §8.

---

## 5. Backend security & correctness (must-haves)

Reproduce all of these (they were audit findings we fixed):

1. **Report workflow enforced server-side.** The report `status` lives in the blob; the server must
   enforce the state machine: only finance/admin may set `approved`/`rejected`; ops may only `draft`/
   `submitted`. Client-side gating is bypassable via the API — **enforce on the write path** (compare old
   vs new status; `403` on unauthorised transition). *(CBRE bug H1.)*
2. **Optimistic locking is mandatory, not optional.** Require the `{data, baseVersion}` envelope with a
   numeric `baseVersion`; reject raw/`NaN` bodies (`400`) so a buggy/malicious client can't skip the
   version check and silently clobber a concurrent edit. `409` on mismatch. *(M1.)*
3. **Notification emails**: resolve recipients **server-side** (submitter from the stored report; finance
   from the users table) — never from the caller-supplied blob. Rate-limit per user to prevent internal
   spam/phishing via status toggling. Escape every user field in email HTML; strip CRLF from subjects;
   allowlist the base URL / Host header (no open redirect). *(H1 + earlier.)*
4. **Route param validation**: reject control chars / overlong `year`/`client` params (`400`) — prevents
   header injection and junk rows. *(finding #4.)*
5. **Role validation on user create** (enum `ops|finance|admin`); **clamp** admin audit-log `limit` to
   `[1,1000]`. *(L7/L8.)*
6. **Password reset**: only store the HMAC of the token; single-use; short expiry; bump `token_version`
   on reset. `/forgot` always returns the **same generic** response even on send failure (no account
   enumeration via status/timing). *(L9.)*
7. **Per-user daily caps** on AI endpoints (chat, insights, extraction) so one user can't drain the
   budget. Blob size guard (e.g. 6 MB) + JSON body limit. *(L9 + earlier.)*
8. **Signed download links**: HMAC over `id.exp`, short expiry, `timingSafeEqual`; re-check access on the
   bearer fallback; server-generated UUID storage paths (no path traversal); `nosniff` +
   `Content-Security-Policy: sandbox` on downloads (neutralise HTML/SVG upload XSS).
9. **JWT**: verify + re-check `token_version` from DB on every request; refuse weak/short `JWT_SECRET` at
   boot; never accept the token from a query string. Bump `token_version` on role/clients change.

> SaaS: add **tenant scoping** to every one of the above checks.

---

## 6. Correctness fixes to bake in (finance math) + regression tests

These are subtle bugs we found and fixed. **Port the fixes AND the tests.** We extracted the logic into
**pure, unit-tested functions** in `calc.js` — do the same (keep components thin).

### 6.1 Partial-payment settlement (pure helpers in `calc.js`)
```
grossOf(r)            = r.total || (amt+vat) || amt
settlementInfo(r)     → {total, settled, balance, paidFlag, paySum, closed, partial}
   // fully closed only when paidFlag AND a settlement date exist, OR payments cover total; else balance.
openBalanceAt(r, monthKey)   // outstanding gross at month-end: 0 before issue / after settlement;
                             // partial payments dated ≤ month reduce it; paid-with-date ≤ month closes it.
cashEvents(r, months, termsMonths) → [[monthKey, amount], …]
   // partial payments land in their own in-year month; residual settles at closure month (paid) or
   // issue+terms (open); out-of-year payments reduce residual without an in-year movement; clamp to Dec.
```
Wire these into: the AP/AR ledger (`settlementInfo`), the group **balance sheet** AR/AP lines
(`openBalanceAt`), and the **cash-flow forecast** (`cashEvents`). **GAP-A:** partial payments must flow to
cash flow AND balance sheet, not only on the full "paid" flag.

### 6.2 Other confirmed fixes
- **M2** — mark-paid / partial payments must **respect the period lock** (a closed month is read-only
  everywhere; guard in the persist path + disable the buttons).
- **M3** — undated open items age into **no** bucket; surface an explicit "Undated" aging column so bucket
  cells reconcile to the row total and the KPIs.
- **M4** — a "paid **without** a settlement date" row must be treated consistently: kept **open** in both
  the ledger and the balance sheet (legacy/import guard) — the two screens must agree.
- **L1** — board-pack PDF must render %-rows (GM%, EBITDA%) as **percentages**, not the raw ratio.
- **L3** — per-counterparty terms key namespaced by AR/AP (no client/supplier name collision).
- **L4** — inline invoice edit: coerce **both** operands (`Number(r.amt)||0`) so imported string/undefined
  values can't produce `NaN`/string totals.
- **L5** — clear the bulk-undo timer on unmount.
- **L6** — balance-sheet VAT must be derived as **gross − net from the same gross used for AR/AP**, so the
  balance identity `AR(gross) = equity(net) + VAT` holds even when a stored `total ≠ amt + vat`.
- **H2** — the **period-lock** map must be in the debounced-save dependency set, or a standalone
  lock/unlock is silently lost on reload. (General lesson: any persisted blob field must be in the
  save-effect deps AND survive the normalize round-trip.)

### 6.3 Prior-year board YoY (`remapFinanceMonths`) — **H3**
The consolidated P&L series filters strictly by the **active FY's** month keys. Prior-year data carries
prior-year keys, so a naive prior-year pass yields **all zeros**. Fix: normalize the prior client data
(`normalizeClientData`) **and** remap the prior finance blob's month-keyed fields
(`remapFinanceMonths`: opex actual/budget, pnl interest/tax, capex month) onto the active FY before
summing — lossless for YTD totals.

### 6.4 Regression tests
Add unit tests (vitest) covering: `grossOf`, `settlementInfo` (open/partial/paid-with-date/paid-without-
date/over-paid), `openBalanceAt` (pre-issue/open/partial-by-month/paid-with-date/paid-without-date),
`cashEvents` (open→terms, partial split, paid→paid-date month, out-of-year, Dec clamp), and
`remapFinanceMonths` (month remap preserves YTD sums). We went from 41 → 59 passing tests. Also keep the
existing coverage: depreciation/NBV, `groupPnLSeries` bridge, aging buckets, anomaly detection.

### 6.5 Backend smoke test
A `scripts/smoke.sh` (`npm run smoke`) that boots the real server against a throwaway SQLite DB and
asserts the security behaviours unit tests can't: workflow authz (ops can't approve → 403), envelope
required (raw/NaN/stale → 400/400/409), IDOR (foreign client → 403), param validation, finance-blob
access, role validation, audit clamp. It's a **dev/CI** gate (needs bash+curl+node+deps) — document that
it does not run inside a minimal Alpine container. **SaaS: add a tenant-isolation assertion** (user of
tenant A cannot read/write tenant B's data → 403/404).

---

## 7. Screen-by-screen restyle checklist

| Screen | Restyle deliverable |
|---|---|
| **All headers** | `AppHeader` (real logo, mono sub-label, pill controls, initials avatar, language toggle). Tab bars → rounded pills. |
| **Client screen** | White header; back pill + client chip; ⌘K search, period-lock pill (red when months locked), Actions menu; tab pills with drag-reorder. |
| **Client Picker (landing)** | `AppHeader` with section nav as `HeaderBtn` pills; role badge chip. |
| **Dashboard** | Hero (consolidated revenue + YoY) + KPI cards; **vertical bar chart** (revenue bars, peak brand, GM/month + GM line); keep anomaly feed, expiring contracts, risk clients, forecast. |
| **Group P&L** | Hero (revenue + EBITDA + margin) + KPI cards; **monthly revenue/EBITDA bar chart**; P&L monthly ⇄ Board Summary; Board Pack button. |
| **AP/AR** | Hero (open balance + overdue) + **aging donut** with legend; DSO/DPO/gap cards; **13-week cash forecast** (diverging chart + table); partial payments; per-counterparty terms. |
| **OPEX/CAPEX** | Hero (OPEX actual + budget/variance) + **OPEX-by-category donut** (top-7 + Other). |
| **Tables (`Tbl`)** | Soft card, sticky header, zebra, locked-row read-only, bulk-select + delete + undo, i18n tooltips. |

---

## 8. Consolidated Board Pack PDF (`exportBoardPack`)

One branded, A4-landscape **print-to-PDF** document combining, from the existing consolidated
computations:
1. **Header** — brand logo + "Board Pack" + FY.
2. **KPI band** — Revenue, Gross Margin (+%), EBITDA (+%), Net (+%).
3. **§1 P&L** — board summary table (Actual YTD / Budget / Var / Var% / Prior / YoY%).
4. **§2 Balance Sheet** (year-end) — derived + manual lines, section totals, and the **balance check**
   (green when ≈0, red otherwise).
5. **§3 Cash Flow** — monthly direct-method statement (collections / payments / payroll / OPEX / CAPEX /
   interest / tax / net / closing) across all months + totals.
6. Footnote (methodology + "generated by …"). All values HTML-escaped; a single "Board Pack" button in
   the Group header (available on every tab). Opens `window.open` → `print()` (handle popup-blocked).

---

## 9. DSO/DPO + 13-week cash forecast (AP/AR)

### 9.1 DSO / DPO
Portfolio-wide, across both AR and AP regardless of the current toggle:
```
revGross = Σ grossOf(inv); costGross = Σ grossOf(sub)
openAR   = Σ settlementInfo(inv).balance; openAP = Σ settlementInfo(sub).balance
DSO = openAR / revGross  × (monthsWithARActivity × 30.42)
DPO = openAP / costGross × (monthsWithAPActivity × 30.42)
gap = DSO − DPO           // >0 = collecting slower than paying → cash pressure (show red)
```
Three KPI cards (DSO, DPO, gap).

### 9.2 13-week working-capital cash forecast
Weekly buckets from the Monday of the current week for 13 weeks. For each **open** invoice/sub: due date =
document date + per-counterparty terms; bucket by due week (**overdue → current week**; beyond week 13 →
skip). Sum expected **collections (AR)** and **payments (AP)** per week; compute weekly **net** and a
**cumulative** running total. Render a **diverging bar chart** (collections up in celadon, payments down in
`rd`, cumulative-net line in brand) + a weekly table (Week / From / Collections / Payments / Net /
Cumulative). Label it clearly **working-capital only** (excludes payroll/OPEX, which live in the finance
blob). *(SaaS: if you also load the finance blob here, you can add payroll/OPEX/CAPEX/tax outflows for a
full cash forecast — a genuine "better than the original".)*

---

## 10. "Do it better" — suggested improvements for the SaaS

Beyond parity, consider:
- **Theme designer** UI for tenant admins (live palette + logo upload + preview) — makes §2.2 first-class.
- **Full 13-week cash forecast** including payroll/OPEX/CAPEX/tax (not just working capital), with an
  editable opening-cash and scenario toggles.
- **Visible approval history** (surface the existing `audit_log`: who submitted/approved/rejected & when,
  per client/month) — an in-app timeline, not just a DB table.
- **Budgeting workflow** — a dedicated budget-entry screen feeding the board Budget column, with
  bottom-up (per client) and top-down reconciliation.
- **Scheduled email digests** (weekly finance summary / overdue AR) via a job runner.
- **Saved views / filters** for the global search and tables.
- **Server-rendered PDFs** (headless Chromium) instead of print-to-PDF, for pixel-perfect board packs
  and email attachments.
- **Charts**: keep them inline-SVG + brand-tokened (accessible in light/dark), never a heavy chart lib.
- **Tests**: keep the "extract pure logic to a tested module" discipline; add tenant-isolation tests.

---

## 11. Acceptance summary (definition of done for the SaaS)

- [ ] Multi-tenant isolation on every route + query; per-tenant theme & logo; tenant-managed clients.
- [ ] One `AppHeader` across all screens; brand logo is uploaded SVG (never typed).
- [ ] Hero cards + charts (bar+line, donut, diverging) on Dashboard / Group / AP-AR / OPEX-CAPEX.
- [ ] Partial payments flow to ledger, balance sheet, and cash flow; aging/DSO/DPO on balances.
- [ ] Board Summary (Actual/Budget/Prior + YoY) + consolidated Board Pack PDF.
- [ ] FTE planner + auto accrual reversal (persisted); bulk delete + undo; ⌘K search (scoped).
- [ ] All §5 backend security controls + §6 correctness fixes, **with regression tests** + a smoke test.
- [ ] 13-week cash forecast; mobile/responsive polish.
- [ ] Prior-year YoY works (finance-month remap); balance sheet balances (VAT single-source).

*Generated from the CBRE MECflow build to seed the MECflow SaaS. Reproduce faithfully, generalise for
multi-tenant, and improve where §10 suggests.*
