import { describe, it, expect } from "vitest";
import { reconcileRows, reconcileLabour, buildReconciliation } from "./importReconcile.jsx";
import { MONTHS } from "./constants.js";

// Simple identity/full key fns for row reconciliation tests.
const idOf = (r) => `${r.month}|${r.cat}|${(r.inv_no || "").toLowerCase()}`;
const fullOf = (r) => `${idOf(r)}|${Math.round((r.amt || 0) * 100) / 100}`;

describe("reconcileRows", () => {
  const sys = [
    { id: "a", month: "2026-01", cat: "X", inv_no: "1", amt: 100 },
    { id: "b", month: "2026-01", cat: "X", inv_no: "2", amt: 200 },
  ];

  it("all new against empty system", () => {
    const r = reconcileRows([{ month: "2026-01", cat: "X", inv_no: "9", amt: 5 }], [], idOf, fullOf);
    expect(r.newRows.length).toBe(1);
    expect(r.changed.length).toBe(0);
    expect(r.onlySys.length).toBe(0);
  });

  it("exact match → MATCH, not changed", () => {
    const r = reconcileRows([{ month: "2026-01", cat: "X", inv_no: "1", amt: 100 }], sys, idOf, fullOf);
    expect(r.match.length).toBe(1);
    expect(r.changed.length).toBe(0);
    expect(r.onlySys.length).toBe(1); // row "b" untouched
  });

  it("same identity, different amount → CHANGED with system id", () => {
    const r = reconcileRows([{ month: "2026-01", cat: "X", inv_no: "1", amt: 150 }], sys, idOf, fullOf);
    expect(r.changed.length).toBe(1);
    expect(r.changed[0].sysId).toBe("a");
    expect(r.match.length).toBe(0);
  });

  it("unmatched system rows surface as onlySys (never deleted)", () => {
    const r = reconcileRows([], sys, idOf, fullOf);
    expect(r.onlySys.length).toBe(2);
    expect(r.newRows.length).toBe(0);
  });

  it("does not double-match one system row to two file rows", () => {
    const file = [
      { month: "2026-01", cat: "X", inv_no: "1", amt: 100 },
      { month: "2026-01", cat: "X", inv_no: "1", amt: 100 },
    ];
    const r = reconcileRows(file, sys, idOf, fullOf);
    expect(r.match.length).toBe(1);   // first consumes "a"
    expect(r.newRows.length).toBe(1); // second has no free match
  });
});

describe("reconcileLabour", () => {
  const m0 = MONTHS[0], m1 = MONTHS[1];
  it("classifies new / changed / match / onlySys and skips 0/0", () => {
    const file = { [m0]: { onsite: 1000, ew_labour: 500 }, [m1]: { pjm_labour: 2775 } };
    const sys = { [m0]: { onsite: 1000, sga: 200 } };
    const cells = reconcileLabour(file, sys);
    const by = (s) => cells.filter(c => c.status === s);
    expect(by("match").find(c => c.k === "onsite" && c.m === m0)).toBeTruthy();     // 1000 == 1000
    expect(by("new").find(c => c.k === "ew_labour" && c.m === m0)).toBeTruthy();    // 0 → 500
    expect(by("new").find(c => c.k === "pjm_labour" && c.m === m1)).toBeTruthy();   // 0 → 2775
    expect(by("onlySys").find(c => c.k === "sga" && c.m === m0)).toBeTruthy();      // 200 → 0
    // no 0/0 noise cell
    expect(cells.find(c => c.fv === 0 && c.sv === 0)).toBeUndefined();
  });
});

describe("buildReconciliation — invoice-number identity prevents duplicates", () => {
  it("same invoice number in a different month → CHANGED, not a new duplicate", () => {
    // System has the scanned row (wrong month May); the P&L file books the SAME invoice to June.
    const sys = [{ id: "s1", month: MONTHS[4], cat: "CLIENT REVENUE - FM Core", inv_no: "2026-742", amt: 22132.24, vat: 5311.74 }];
    const parsed = {
      inv: [{ month: MONTHS[5], cat: "CLIENT REVENUE - FM Core", inv_no: "2026-742", amt: 22132.24, vat: 5311.74 }],
      sub: [], lab: {},
    };
    const rec = buildReconciliation(parsed, { inv: sys, sub: [], lab: {} });
    expect(rec.inv.newRows.length).toBe(0);       // NOT re-added
    expect(rec.inv.changed.length).toBe(1);       // recognized as the same invoice, updated
    expect(rec.inv.changed[0].sysId).toBe("s1");
  });
  it("line items of one invoice (same number, different amounts) stay distinct — not merged", () => {
    // Invoice 2026-478 has 3 separate line items; none should collapse into another.
    const parsed = { inv: [
      { month: MONTHS[3], cat: "CLIENT REVENUE - FM Core", inv_no: "2026-478", amt: 5461, vat: 1310.64 },
      { month: MONTHS[3], cat: "CLIENT REVENUE - FM Core", inv_no: "2026-478", amt: 117, vat: 28.08 },
      { month: MONTHS[3], cat: "CLIENT REVENUE - FM Core", inv_no: "2026-478", amt: 975, vat: 234 },
    ], sub: [], lab: {} };
    const rec = buildReconciliation(parsed, { inv: [], sub: [], lab: {} });
    expect(rec.inv.newRows.length).toBe(3);   // all three kept as distinct new rows
    expect(rec.inv.changed.length).toBe(0);
  });
  it("identical invoice (same month/amount) → MATCH, no action", () => {
    const row = { month: MONTHS[5], cat: "CLIENT REVENUE - FM Core", inv_no: "2026-742", amt: 22132.24, vat: 5311.74 };
    const rec = buildReconciliation({ inv: [row], sub: [], lab: {} }, { inv: [{ ...row, id: "s1" }], sub: [], lab: {} });
    expect(rec.inv.match.length).toBe(1);
    expect(rec.inv.newRows.length).toBe(0);
    expect(rec.inv.changed.length).toBe(0);
  });
});

describe("buildReconciliation", () => {
  it("wires inv/sub/lab sections together", () => {
    const parsed = {
      inv: [{ month: MONTHS[0], cat: "CLIENT REVENUE - FM Core", inv_no: "1", amt: 10, vat: 2.4 }],
      sub: [{ month: MONTHS[0], cat: "Subcontractors cost - FM Core", supplier: "S", inv_no: "9", amt: 5 }],
      lab: { [MONTHS[0]]: { onsite: 100 } },
    };
    const rec = buildReconciliation(parsed, { inv: [], sub: [], lab: {} });
    expect(rec.inv.newRows.length).toBe(1);
    expect(rec.sub.newRows.length).toBe(1);
    expect(rec.lab.filter(c => c.status === "new").length).toBe(1);
  });
});
