// Golden tests for the invoice amount validation/auto-correction rules.
// These rules guard every AI-extracted invoice before it reaches the books.
import { describe, it, expect } from "vitest";
import { validateAmounts } from "../lib/validate.js";

describe("validateAmounts", () => {
  it("passes a clean invoice through unchanged (45 / 10.80 / 55.80)", () => {
    const r = validateAmounts({ net_amount: 45, vat_amount: 10.8, total_amount: 55.8, vat_rate: 24 });
    expect(r.net).toBe(45);
    expect(r.vat).toBe(10.8);
    expect(r.total).toBe(55.8);
    expect(r.warnings).toHaveLength(0);
  });

  it("Rule 1: swaps net/vat when they are reversed", () => {
    const r = validateAmounts({ net_amount: 10.8, vat_amount: 45, total_amount: 55.8, vat_rate: 24 });
    expect(r.net).toBe(45);
    expect(r.vat).toBe(10.8);
    expect(r.warnings.some(w => w.includes("swapped"))).toBe(true);
  });

  it("Rule 2: derives net+vat from total when net=0 (PITFALL 3 regression)", () => {
    const r = validateAmounts({ net_amount: 0, vat_amount: 0, total_amount: 124, vat_rate: 24 });
    expect(r.net).toBe(100);
    expect(r.vat).toBe(24);
  });

  it("Rule 3: derives total from net+vat when total=0", () => {
    const r = validateAmounts({ net_amount: 100, vat_amount: 24, total_amount: 0, vat_rate: 24 });
    expect(r.total).toBe(124);
  });

  it("Rule 4: flags arithmetic mismatch without silently 'fixing' it", () => {
    const r = validateAmounts({ net_amount: 100, vat_amount: 24, total_amount: 200, vat_rate: 24 });
    expect(r.warnings.some(w => w.includes("≠"))).toBe(true);
  });

  it("PITFALL 2 (Rainbow Waters): balance-as-vat NEVER passes silently — some warning must fire", () => {
    // Rule 1 swaps first (vat>net), then Rule 4 flags the arithmetic mismatch → reviewer attention
    const r = validateAmounts({ net_amount: 112.32, vat_amount: 6066.15, total_amount: 139.28, vat_rate: 24 });
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("Rule 5: flags hijack when vat is absurd but still below net (no swap path)", () => {
    const r = validateAmounts({ net_amount: 10000, vat_amount: 9000, total_amount: 19000, vat_rate: 24 });
    expect(r.warnings.some(w => w.includes("hijack"))).toBe(true);
  });

  it("credit notes: all amounts forced negative", () => {
    const r = validateAmounts({ net_amount: 45, vat_amount: 10.8, total_amount: 55.8, vat_rate: 24, is_credit_note: true });
    expect(r.net).toBeLessThan(0);
    expect(r.vat).toBeLessThan(0);
    expect(r.total).toBeLessThan(0);
  });

  it("handles EU-parsed zero-ish garbage without NaN", () => {
    const r = validateAmounts({ net_amount: "abc", vat_amount: null, total_amount: undefined, vat_rate: 24 });
    expect(Number.isNaN(r.net)).toBe(false);
    expect(Number.isNaN(r.total)).toBe(false);
  });

  it("zero-rated invoice (0% VAT) is preserved, not fabricated to 24%", () => {
    // Reverse-charge / intra-community: net = total, VAT genuinely 0.
    const r = validateAmounts({ net_amount: 1000, vat_amount: 0, total_amount: 1000, vat_rate: 0 });
    expect(r.net).toBe(1000);
    expect(r.vat).toBe(0);
    expect(r.total).toBe(1000);
    expect(r.warnings).toHaveLength(0);
  });

  it("zero-rated with only total present derives net=total, vat=0 (no invented tax)", () => {
    const r = validateAmounts({ net_amount: 0, vat_amount: 0, total_amount: 500, vat_rate: 0 });
    expect(r.net).toBe(500);
    expect(r.vat).toBe(0);
    expect(r.total).toBe(500);
  });

  it("missing vat_rate still defaults to 24% for derivation", () => {
    const r = validateAmounts({ net_amount: 0, vat_amount: 0, total_amount: 124 });
    expect(r.net).toBe(100);
    expect(r.vat).toBe(24);
  });
});
