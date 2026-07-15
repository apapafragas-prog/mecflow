// Server-side validation & auto-correction of AI-extracted invoice amounts.
// Pure function so it can be unit-tested (see backend/tests/validate.test.js).
export const validateAmounts = (data) => {
  const warnings = [];
  let net = Number(data.net_amount) || 0;
  let vat = Number(data.vat_amount) || 0;
  let total = Number(data.total_amount) || 0;
  // Respect an EXPLICIT 0% rate (intra-community, reverse-charge art. 39a, exempt) — only default
  // to 24% when the rate is genuinely absent/unparseable. `|| 24` would turn a real 0 into 24.
  const rr = data.vat_rate;
  const rate = (rr === null || rr === undefined || rr === "" || Number.isNaN(Number(rr))) ? 24 : Number(rr);
  const isCredit = !!data.is_credit_note;

  // Rule 1: net must be > vat (Greek VAT max 24%)
  if (Math.abs(vat) > Math.abs(net) && Math.abs(net) > 0) {
    warnings.push(`vat(${Math.abs(vat)}) > net(${Math.abs(net)}) — swapped automatically`);
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

  return { net, vat, total, warnings };
};
