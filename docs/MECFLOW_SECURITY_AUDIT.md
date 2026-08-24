# MECflow (CBRE Hellas Reporting) — Security & GDPR Audit Report

**Classification:** Confidential — Internal / IT & Finance review
**Prepared for:** CBRE Hellas management, IT Security & Finance approval
**Scope:** Full platform — application (Node/Express + React), data protection/GDPR, deployment/infrastructure
**Method:** Static code review + dependency vulnerability scanning + configuration review, across four independent audit tracks (Authentication/Session, Data Protection/GDPR, Application Security/OWASP, Infrastructure/DevSecOps).
**Assessed against:** OWASP Top 10 / ASVS L2, ISO 27001 (A.5/A.8), SOC 2 CC6, GDPR (EU 2016/679).

---

## 1. Executive summary

MECflow is a well-engineered application. The **server-side code is above average for its size** — parameterised SQL (no SQL injection), React auto-escaping (no XSS in the app), role-based access control enforced server-side, signed short-lived download links, JWT session revocation, a hardened password-reset flow, and layered rate limiting. On pure *code quality*, it is close to an enterprise appsec pass.

**However, the platform as currently deployed and governed will NOT pass a multinational IT & Finance security review.** The blockers are not the application logic — they are **hosting model, identity, encryption, and data-governance** gaps, plus a small number of concrete technical fixes.

### Overall risk rating: **HIGH** (not approvable on current architecture)

| Domain | Rating | One-line verdict |
|---|---|---|
| Application security (code) | 🟢 Good | Strong; needs security headers + 2 dependency upgrades |
| Authentication / identity | 🔴 High risk | No MFA, no corporate SSO, token in localStorage |
| Data protection / GDPR | 🔴 High risk | US AI transfer without DPA, no encryption at rest, missing governance pack |
| Infrastructure / hosting | 🔴 Critical | Self-hosted consumer NAS; secrets in env; no SIEM/DR |

### Go / No-Go: **Conditional — not yet.**
The application can support a **conditional pass** *after* the Priority-1 and Priority-2 remediations below (chiefly: move off the NAS to an approved environment, add MFA/SSO, encrypt at rest, execute the AI/email sub-processor agreements, and apply the quick code fixes).

---

## 2. Findings register (consolidated, de-duplicated)

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. Type: **Code** (fixable in the app), **Infra** (deployment/architecture), **Gov** (governance/paperwork).

| ID | Severity | Type | Finding |
|----|----------|------|---------|
| **F-01** | 🔴 Critical | Infra | Production runs on a **self-hosted consumer Synology NAS** — no data-centre physical controls, manual patching, single point of failure, not an enterprise-sanctioned environment. |
| **F-02** | 🔴 High | Code/Infra | **No MFA and no corporate SSO (SAML/OIDC).** Single-factor local passwords only. |
| **F-03** | 🔴 High | Code | **JWT stored in `localStorage`** → any XSS steals a 24h bearer token. Compounded by F-04. |
| **F-04** | 🔴 High | Code | **No app-level HTTP security headers** (no `helmet`, CSP, HSTS, X-Frame-Options) → clickjacking, no XSS defence-in-depth, TLS-downgrade risk. |
| **F-05** | 🔴 High | Code | **Vulnerable `pdfjs-dist` (CVE-2024-4367)** on the invoice-scan render path → malicious PDF executes JS in the app origin → token theft. |
| **F-06** | 🔴 High | Code | **Vulnerable `nodemailer` (≤9.0.0)** — multiple SMTP/CRLF-injection & SSRF advisories. Upgrade required. |
| **F-07** | 🔴 High | Gov | **Raw invoices & contracts sent to the Anthropic API (US)** for AI extraction with **no documented DPA/SCCs**, no data-minimisation, and an internal note that *falsely* claims raw documents are never sent. |
| **F-08** | 🔴 High | Infra | **No encryption at rest** — SQLite DB, uploaded contracts/invoices, and backups stored in cleartext on the NAS. |
| **F-09** | 🔴 High | Infra | **Secrets as environment variables** (visible via `docker inspect`); the **Cloudflare tunnel token was exposed and must be rotated**; no secret manager/rotation. |
| **F-10** | 🔴 High | Infra | **Container runs as root**; shares a Docker network with an unrelated *hr-portal* app (lateral movement); a LAN-published port bypasses the edge. |
| **F-11** | 🔴 High | Infra | **Audit log lives inside the same SQLite DB** (tamperable by anyone reaching the DB); **no SIEM / centralised logging / alerting**. |
| **F-12** | 🔴 High | Infra | **Single NAS = SPOF**; backups unencrypted on the *same* NAS; offsite copy optional; no tested RPO/RTO. |
| **F-13** | 🟠 Medium | Code | **Client identities leak to Clearbit & Google** — every dashboard load sends client corporate domains (pfizer.com, jpmorgan.com…) to two US third parties for logo fetch. |
| **F-14** | 🟠 Medium | Gov | **Zoho SMTP is an undocumented sub-processor**; the app emails **full P&L tables** to arbitrary caller-supplied recipients (no approved-domain allowlist). |
| **F-15** | 🟠 Medium | Code | **Weak password lifecycle**: seed default `ChangeMe!2026` committed to source; admin-created users not forced to change password; 8-char min, no breach/complexity check. |
| **F-16** | 🟠 Medium | Code | **`.env.example` placeholder JWT secret** (50 chars) passes the weak-secret guard → operator may boot with a publicly known signing key. |
| **F-17** | 🟠 Medium | Code | **Tesseract.js loaded from a CDN without Subresource Integrity (SRI)** → CDN compromise/MITM injects JS. |
| **F-18** | 🟠 Medium | Code | **Client-side-only logout**; 24h token, no idle/absolute timeout, no server-side session termination or per-device revocation. |
| **F-19** | 🟠 Medium | Code | **No per-account lockout** beyond IP rate-limiting; `trust proxy` may allow `X-Forwarded-For` spoofing of the login limiter. |
| **F-20** | 🟠 Medium | Code | **Internal error messages returned to clients** (SQLite constraint text, library internals) — info disclosure. |
| **F-21** | 🟠 Medium | Gov | **IP-address logging**: no documented lawful basis; 18-month retention; hard-deleting a user leaves residual identifiers in audit/authorship. |
| **F-22** | 🟠 Medium | Gov | **No data-subject-rights mechanism** (access/export/erasure). |
| **F-23** | 🟠 Medium | Gov | **Missing GDPR governance artefacts**: RoPA (Art. 30), DPIA (Art. 35), privacy notice, sub-processor register, breach runbook, retention policy. |
| **F-24** | 🟠 Medium | Infra | **Plaintext HTTP origin** (Cloudflare→origin); confirm Cloudflare SSL mode = **Full (Strict)**. |
| **F-25** | 🟠 Medium | Infra | **CI does not gate on vulnerabilities** (`npm audit \|\| true`); no image scanning, SBOM, or signed images. |
| **F-26** | 🟡 Low | Gov/Infra | **Confidential client roster committed in seed code** (37 named multinationals in `init-db.js`/`constants.js`). |
| **F-27** | 🟡 Low | Code | JWT algorithm not pinned; bcrypt cost 10 (raise to ≥12); reset-token HMAC reuses the JWT secret; `window.open` without `noopener`; unlimited concurrent sessions; `xlsx` sourced off-registry (version is safe but bypasses `npm audit`). |

---

## 3. What is already strong (credit where due)

A multinational reviewer will value these existing controls — they materially shorten the path to approval:

- **No SQL injection** — better-sqlite3 parameterised statements throughout; the only interpolated SQL uses hardcoded table names.
- **No XSS in the app** — no `dangerouslySetInnerHTML`; React auto-escapes; AI chat renders via safe JSX text nodes; print-to-PDF and email HTML escape every interpolated user value.
- **Access control is server-side, not just UI** — `requireRole` + per-client `canAccess` on every data/file route; report approval state-machine (only finance/admin approve) enforced on the write path; optimistic locking prevents silent overwrites; no IDOR found.
- **File handling hardened** — uploads stored under random UUID names; downloads via **120-second HMAC-signed links** with constant-time comparison and **`nosniff` + `CSP: default-src 'none'; sandbox`** (neutralises stored-XSS from uploaded HTML/SVG); no path traversal.
- **Auth hygiene** — boot **fails hard** on a missing/short JWT secret; `token_version` session revocation on password/role/entitlement change; bcrypt hashing; forced default-password change; **no user enumeration** on `/forgot`; reset tokens stored only as HMAC hashes, 30-min expiry, single-use.
- **Abuse resistance** — layered rate limiting (login user+IP and IP-only, forgot, AI extract/chat/insights with per-user daily caps, report-email); 12 MB JSON body + 6 MB blob + upload size caps; host-header-injection guard; CORS same-origin by default; anchored regexes (no ReDoS).
- **Operational hygiene** — 18-month audit purge + reset-token cleanup; a well-designed backup script (consistent snapshot, rotation); a CI pipeline running tests, lint, and build; **no secrets committed to git** and a correct `.gitignore`.
- **AI minimisation on chat/insights** — only rounded aggregates and risk labels are sent (the *correct* pattern). *(The scan/extract path is the exception — see F-07.)*

---

## 4. GDPR compliance assessment (summary)

**Data processed:** employee names/emails + password hashes + IP addresses (audit); client financials (P&L, invoices, contracts, supplier ΑΦΜ/VAT, IBAN lines); uploaded PDF/image documents; the client roster itself.

| GDPR area | Status | Blocking finding(s) |
|---|---|---|
| Lawful third-country transfer (Art. 44-49) | ❌ Not evidenced | F-07 (Anthropic US), F-13 (Clearbit/Google) |
| Processor / sub-processor agreements (Art. 28) | ❌ Missing | F-07, F-14 (Zoho) |
| Security of processing (Art. 32) | ⚠️ Partial | F-08 (no encryption at rest), F-01/F-10/F-11 |
| Data minimisation (Art. 5(1)(c)) | ⚠️ Partial | F-07 (whole docs to AI), F-21 (IP) |
| Records of processing / DPIA (Art. 30/35) | ❌ Missing | F-23 |
| Data-subject rights (Art. 15-20) | ❌ Missing | F-22 |
| Transparency / privacy notice (Art. 13/14) | ❌ Missing | F-23 |
| Breach notification readiness (Art. 33-34) | ❌ Missing | F-23 |

**DPO verdict:** would not pass a data-protection review as-is. The blocking items are the un-agreed US AI transfer of raw documents, the absence of encryption at rest, the third-party client-domain leak, and the missing governance pack.

---

## 5. Remediation roadmap

### Priority 1 — Immediate (this week; mostly quick, low-risk)
1. **Rotate all secrets now** (assume the tunnel token, and by extension the environment, is compromised): Cloudflare tunnel token, `JWT_SECRET`, `ANTHROPIC_API_KEY`, SMTP password. *(F-09)*
2. **Upgrade `pdfjs-dist` ≥ 4.2.67** (or set `isEvalSupported:false` as interim) and **`nodemailer` ≥ 9.0.5**; run `npm audit` in both packages and make CI **fail** on high/critical (remove `|| true`). *(F-05, F-06, F-25)*
3. **Add `helmet`** with a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`), **HSTS**, `Referrer-Policy`, `Permissions-Policy`. *(F-04)*
4. **Remove the Clearbit/Google logo fetch** — self-host logos or use the existing coloured-initials fallback. *(F-13)*
5. **Harden secrets & the `.env.example`** — add the placeholder to the weak-secret blocklist; reject `/CHANGE|PLACEHOLDER|RANDOM/i`. *(F-16)*
6. **Bundle Tesseract.js locally** (or add SRI). *(F-17)*
7. **Password lifecycle**: stop committing a shared default (unique per-user, out-of-band); force `must_change_password` on admin-created users; raise min length to 12 + breach check; bcrypt cost 12. *(F-15, F-27)*
8. **Generic error responses** + a global error handler. *(F-20)*
9. **Report-email recipient allowlist** (approved domains only). *(F-14 partial)*

> Most of Priority 1 is application code we can implement and verify quickly.

### Priority 2 — Short term (weeks; architecture & identity)
10. **Move off the NAS to an enterprise-approved environment** — managed cloud container platform (Azure App Service / AWS ECS-Fargate / GCP Cloud Run) or CBRE-sanctioned on-prem, with a **managed, encrypted-at-rest database** and automated backups + point-in-time restore. *(F-01, F-08, F-12)*
11. **Corporate SSO (OIDC/SAML) + mandatory MFA** (via Azure AD/Okta), enforced especially for admin/finance; move the JWT out of `localStorage` into a `Secure; HttpOnly; SameSite` cookie with CSRF protection, or front the app with **Cloudflare Access (Zero-Trust)**. *(F-02, F-03, F-18)*
12. **Network segmentation** — dedicated network (no hr-portal co-tenancy); loopback-only origin binding; remove any LAN/port-forward path; Cloudflare SSL **Full (Strict)** + WAF + rate-limiting. *(F-10, F-24)*
13. **Container hardening** — non-root user, builder stage (drop compilers from runtime), digest-pinned base image, `read_only` FS, `cap_drop: [ALL]`, `no-new-privileges`, resource limits, image scanning gated in CI. *(F-10, F-25)*
14. **Secret manager / KMS** with a rotation schedule (Docker secrets as a floor). *(F-09)*
15. **Centralised logging to a SIEM** (immutable/off-box audit trail) with alerting on auth failures, privilege changes, and data-access anomalies. *(F-11)*
16. **Encrypted, offsite/immutable backups** with defined & tested RPO/RTO. *(F-12)*
17. **Session controls** — short-lived access token (~15 min) + rotating refresh, real server-side logout, idle + absolute timeouts, per-account lockout, correct `trust proxy`. *(F-18, F-19)*

### Priority 3 — Governance (parallel; required for sign-off)
18. **Execute an Anthropic DPA + SCCs**, enable zero-data-retention, add Anthropic to the sub-processor register and privacy notice, correct the misleading internal note, and **minimise/redact before sending** (or use an EU-hosted extraction model). *(F-07)*
19. **Sub-processor register** incl. Anthropic, Zoho (DPA), Cloudflare, and Clearbit/Google if retained. *(F-14, F-23)*
20. **Produce the GDPR pack** — RoPA (Art. 30), **DPIA** (Art. 35), privacy notice, retention policy, breach-response runbook, and **DSAR/erasure procedures**. *(F-21, F-22, F-23)*
21. Treat the **client roster as confidential** — remove it from seed source; load per-tenant at runtime. *(F-26)*

---

## 6. Conclusion

**The application is well built; the deployment and governance are not yet enterprise-grade.** None of the blocking issues stem from poor coding — they are the predictable gaps of a capable internal tool that now needs to meet a multinational's bar: identity federation + MFA, a sanctioned hosting environment, encryption at rest, centralised monitoring, and the GDPR paperwork for its AI and email data flows.

**Recommendation:** Present this report to IT & Finance as an honest, self-initiated assessment with a concrete remediation plan. Position the current NAS deployment as a **successful pilot**, and seek approval to (a) apply the Priority-1 code fixes immediately, and (b) fund the Priority-2 migration to a CBRE-sanctioned environment with SSO/MFA and the Priority-3 governance work. With those in place, the platform's strong access-control and application-security foundations support a **conditional production approval**.

---

*Appendix — dependency scan (at time of audit):* `nodemailer ≤9.0.0` (High), `pdfjs-dist ≤4.7.76` incl. CVE-2024-4367 (High), `brace-expansion` (DoS), `node-tar` (build-time), `xlsx@0.20.3` sourced from the SheetJS CDN (version patched, but off-registry). Re-run `npm audit` after each upgrade.
