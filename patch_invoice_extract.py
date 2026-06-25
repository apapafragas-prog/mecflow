#!/usr/bin/env python3
"""
Patch script for /volume1/docker/cbre/backend/server.js
Replaces the /api/extract/invoice endpoint with:
  - A much stronger prompt that distinguishes supplier vs customer,
    handles Greek invoice layouts, and explicitly ignores account-balance fields
  - Server-side validation that catches net<=vat, sum mismatches,
    and statement-balance hijacks before returning to the frontend

Backup is created automatically as server.js.bak.<timestamp>
"""
import re, sys, time, os, shutil

PATH = '/volume1/docker/cbre/backend/server.js'

if not os.path.exists(PATH):
    print(f"ERROR: {PATH} not found", file=sys.stderr)
    sys.exit(1)

# Backup
ts = time.strftime("%Y%m%d-%H%M%S")
backup = f"{PATH}.bak.{ts}"
shutil.copy2(PATH, backup)
print(f"✓ Backup saved: {backup}")

with open(PATH, 'r', encoding='utf-8') as f:
    content = f.read()

# Verify markers exist
if '// POST /api/extract/invoice' not in content:
    print("ERROR: start marker not found", file=sys.stderr)
    sys.exit(1)
if '// POST /api/extract/contract' not in content:
    print("ERROR: end marker not found", file=sys.stderr)
    sys.exit(1)

NEW_BLOCK = r'''// POST /api/extract/invoice — extract invoice fields from PDF/image (vision-enabled)
app.post("/api/extract/invoice", auth, extractLimiter, extractUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const mode = (req.body.mode || "AP").toUpperCase(); // AR or AP

  const prompt = `You are an invoice data extraction system for Greek and English invoices. Extract fields and respond with ONLY valid JSON (no markdown, no commentary).

═══════════════════════════════════════════════════════════
CRITICAL — SUPPLIER vs CUSTOMER DISTINCTION
═══════════════════════════════════════════════════════════

The SUPPLIER is the company that ISSUED this invoice (will RECEIVE payment).
The CUSTOMER is the company that RECEIVED the invoice (will PAY).
NEVER confuse them.

How to find the SUPPLIER (issuer) in a Greek invoice:
• Logo + company name at the TOP HEADER of the page
• Company info block at top: name, address, Α.Φ.Μ., ΔΟΥ, ΓΕΜΗ
• Often appears with "Έκδοση" / "Εκδόθηκε από" / "Issued by"

How to identify the CUSTOMER (recipient — NOT the supplier):
• Under sections labeled:
  - "ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" / "Στοιχεία Πελάτη" / "Client's Particulars"
  - "ΣΤΟΙΧΕΙΑ ΣΥΝΑΛΛΑΣΣΟΜΕΝΟΥ"
  - "Επωνυμία Πελάτη" / "Client's Name" / "Bill to"
  - "Πελάτης" / "Customer"
• If "CBRE HELLAS" appears under any of these → CBRE is the CUSTOMER, not the supplier.

For ${mode === "AR" ? "AR mode (CBRE-issued client invoices)" : "AP mode (supplier invoices billed TO CBRE)"}:
${mode === "AR"
  ? "→ supplier_name = CBRE Hellas or Atria (the issuer at the top header)"
  : "→ supplier_name = the VENDOR who billed CBRE (the company at the TOP HEADER). It is NEVER 'CBRE Hellas'."}

═══════════════════════════════════════════════════════════
INVOICE NUMBER — always present, never leave blank
═══════════════════════════════════════════════════════════

Look for these labels in the document header:
• "Αριθμός Παραστατικού" / "Αρ. Παραστατικού" / "Doc Number"
• "ΑΡΙΘΜΟΣ" / "Νο" / "Nb" / "No." / "Number"
• "Σειρά - Αριθμός" / "Series - Number"
• Often appears right next to "ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧΗΣ ΥΠΗΡΕΣΙΩΝ" or in a table cell

Always include the prefix as printed. Examples of valid invoice numbers:
• "ΤΠΥ-08408", "Α-ΤΙΜ0129366", "ΤΠΥI 12559", "Α 661", "3343", "10"

If the document title says "ΤΙΜΟΛΟΓΙΟ ΠΑΡΟΧ.ΥΠΗΡΕΣΙΩΝ" and a number "12559" appears nearby → that IS the invoice number.

═══════════════════════════════════════════════════════════
AMOUNT EXTRACTION — bottom summary only
═══════════════════════════════════════════════════════════

Find the BOTTOM SUMMARY of the invoice. Look for these labels:
• ΚΑΘΑΡΗ ΑΞΙΑ / Net Value / Καθαρή Αξία / Cost excl. VAT / Αξία προ ΦΠΑ → net_amount
• ΑΞΙΑ Φ.Π.Α. / ΦΠΑ / VAT / VAT Cost / Αξία Φ.Π.Α. → vat_amount
• ΠΛΗΡΩΤΕΟ / Σύνολο / Total / Πληρωτέο Ποσό / Συνολική Τελική Αξία / Σύνολο (ευρώ) → total_amount

⚠️ CRITICAL — IGNORE THESE FIELDS (they are NOT invoice amounts):
• "ΠΡΟΗΓ. ΥΠΟΛΟΙΠΟ" / "Προηγούμενο Υπόλοιπο" — previous account balance
• "ΝΕΟ ΥΠΟΛΟΙΠΟ" / "Νέο Υπόλοιπο" — running account balance
• Bank account numbers, IBAN
• Anything labeled "balance" or "υπόλοιπο"

⚠️ Greek line-item tables have columns ΠΟΣΟΤΗΤΑ | ΤΙΜΗ | ΑΞΙΑ | ΕΚΠΤ% | ΑΞΙΑ | ΦΠΑ%.
The "ΑΞΙΑ" in line items is PER LINE, not the total. Always use the bottom summary totals.

═══════════════════════════════════════════════════════════
HARD VALIDATION — must pass before returning
═══════════════════════════════════════════════════════════

Before returning JSON, verify:
1. net_amount > vat_amount (ALWAYS for Greek VAT 6/13/24%). If vat ≥ net, you have swapped them — fix it.
2. |net_amount + vat_amount − total_amount| < 0.05 (within rounding)
3. vat_amount ≈ net_amount × (vat_rate/100) ± 0.05
4. net_amount ≠ 0 when total_amount > 0
5. The numbers must come from the invoice's OWN bottom summary, never from a "ΠΡΟΗΓ ΥΠΟΛΟΙΠΟ" balance.

If validation fails, re-examine the document before answering.

═══════════════════════════════════════════════════════════
COMMON PITFALLS (real examples — do not repeat these mistakes)
═══════════════════════════════════════════════════════════

PITFALL 1 — ATRIA invoicing CBRE:
Header: "ATRIA ΥΠΗΡΕΣΙΕΣ ΑΚΙΝΗΤΩΝ Α.Ε." (ΑΦΜ 999211159)
"ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ" section: CBRE HELLAS (ΑΦΜ 800672920)
✓ CORRECT: supplier_name="ATRIA ΥΠΗΡΕΣΙΕΣ ΑΚΙΝΗΤΩΝ Α.Ε.", afm="999211159"
✗ WRONG: supplier_name="CBRE HELLAS"

PITFALL 2 — Rainbow Waters multi-page statement:
Each page shows: ΣΥΝ.ΠΟΣΟΤ 1,00 | ΑΞΙΑ 112,32 | ΦΠΑ 26,96 | ΣΥΝΟΛΟ ΑΓΟΡΩΝ 139,28
Also: ΠΡΟΗΓ.ΥΠΟΛΟΙΠΟ 6.066,15 (account balance — IGNORE)
✓ CORRECT: net=112.32, vat=26.96, total=139.28
✗ WRONG: vat=6066.15 (that's the account balance, not invoice VAT)

PITFALL 3 — Landscape ΤΠΥ-08408 single-line invoice:
Single line: ΚΗΠΟΤΕΧΝΙΚΕΣ ΕΡΓΑΣΙΕΣ | 1,00 | 45,00 | 24%
Bottom: ΚΑΘΑΡΗ ΑΞΙΑ 45,00 | ΑΞΙΑ Φ.Π.Α. 10,80 | ΠΛΗΡΩΤΕΟ ΠΟΣΟ 55,80
✓ CORRECT: net=45.00, vat=10.80, total=55.80
✗ WRONG: net=0, vat=45, total=45 (violates net > vat!)

PITFALL 4 — Documents starting with "<%SP1>" or other markup:
The PDF text may begin with internal markup tags. Skip these.
The real supplier name (e.g. "A&M Architects A.E.") is in the visible logo/header.

═══════════════════════════════════════════════════════════
OUTPUT FORMAT (JSON only, no markdown)
═══════════════════════════════════════════════════════════

{
  "supplier_name": "name of ISSUER (top header). Greek or English. Max 60 chars.",
  "afm": "issuer's 9-digit ΑΦΜ (no EL prefix, no spaces)",
  "invoice_number": "full invoice number with prefix as printed (e.g. ΤΠΥ-08408, Α-ΤΙΜ0129366)",
  "invoice_date": "DD/MM/YYYY",
  "month": "YYYY-MM",
  "net_amount": numeric_net_pre_vat_EUR,
  "vat_amount": numeric_vat_EUR,
  "vat_rate": numeric_percent_24_or_13_or_6_or_0,
  "total_amount": numeric_total_with_vat_EUR,
  "description": "brief description of goods/services (max 80 chars)",
  "is_credit_note": true_if_ΠΙΣΤΩΤΙΚΟ_ΤΙΜΟΛΟΓΙΟ_else_false
}

For credit notes (ΠΙΣΤΩΤΙΚΟ ΤΙΜΟΛΟΓΙΟ): all amounts NEGATIVE.
Convert EU decimals: "1.234,56" → 1234.56`;

  try {
    const data = await callClaudeExtract(req.file, prompt);

    // ── Server-side validation & auto-correction ──
    const warnings = [];
    let net = Number(data.net_amount) || 0;
    let vat = Number(data.vat_amount) || 0;
    let total = Number(data.total_amount) || 0;
    const rate = Number(data.vat_rate) || 24;
    const isCredit = !!data.is_credit_note;
    const absNet = Math.abs(net), absVat = Math.abs(vat), absTotal = Math.abs(total);

    // Rule 1: net must be > vat (Greek VAT max 24%)
    if (absVat > absNet && absNet > 0) {
      warnings.push(`vat(${absVat}) > net(${absNet}) — swapped automatically`);
      [net, vat] = [vat, net];
    }

    // Rule 2: if net=0 but total>0 → derive
    if (Math.abs(net) === 0 && Math.abs(total) > 0) {
      warnings.push("net=0 with total>0 — derived from total/vat_rate");
      const derivedNet = total / (1 + rate / 100);
      const derivedVat = total - derivedNet;
      net = Math.round(derivedNet * 100) / 100;
      vat = Math.round(derivedVat * 100) / 100;
    }

    // Rule 3: if total=0 but net+vat>0
    if (Math.abs(total) === 0 && (Math.abs(net) > 0 || Math.abs(vat) > 0)) {
      warnings.push("total=0 — derived from net+vat");
      total = net + vat;
    }

    // Rule 4: arithmetic sanity
    const sumCheck = Math.abs(Math.abs(net) + Math.abs(vat) - Math.abs(total));
    if (sumCheck > 0.05) {
      warnings.push(`net+vat ≠ total (diff=${sumCheck.toFixed(2)})`);
    }

    // Rule 5: detect "previous balance" hijack — vat absurdly bigger than net×rate
    if (Math.abs(net) > 0 && rate > 0) {
      const expectedVat = Math.abs(net) * (rate / 100);
      if (Math.abs(vat) > expectedVat * 2.5) {
        warnings.push(`vat(${Math.abs(vat)}) far exceeds net×rate(${expectedVat.toFixed(2)}) — possible statement-balance hijack`);
      }
    }

    // Restore sign for credit notes
    if (isCredit) {
      if (net > 0) net = -net;
      if (vat > 0) vat = -vat;
      if (total > 0) total = -total;
    }

    if (warnings.length) console.log(`[extract/invoice] warnings:`, warnings);

    res.json({
      ...data,
      net_amount: net,
      vat_amount: vat,
      total_amount: total,
      _warnings: warnings.length ? warnings : undefined
    });
  } catch (e) {
    console.error("Extract invoice error:", e.message);
    res.status(500).json({ error: e.message || "Extraction failed" });
  }
});

'''

# Replace the block (from "// POST /api/extract/invoice" up to but not including "// POST /api/extract/contract")
pattern = re.compile(
    r'// POST /api/extract/invoice.*?(?=// POST /api/extract/contract)',
    re.DOTALL
)

new_content, n = pattern.subn(lambda _: NEW_BLOCK, content)

if n != 1:
    print(f"ERROR: expected 1 replacement, got {n}", file=sys.stderr)
    sys.exit(1)

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f"✓ Patched {PATH}")
print(f"  Original size: {len(content)} bytes")
print(f"  New size:      {len(new_content)} bytes")
print()
print("Next steps:")
print("  cd /volume1/docker/cbre")
print("  sudo docker-compose down")
print("  sudo docker-compose build --no-cache")
print("  sudo docker-compose up -d")
print("  sudo docker logs cbre-reporting --tail 10")
