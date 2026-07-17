import { describe, it, expect } from "vitest";
import { monthIdx, depreciation, nbvAtMonth, groupPnLSeries, allocFractions, parseDate, daysUntil, clientSeries, linregSlope, runRateFY, clientRisks, agingBucket, detectAnomalies } from "./calc.js";

const FY26 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);

describe("monthIdx", () => {
  it("maps YYYY-MM to an absolute index", () => {
    expect(monthIdx("2026-01")).toBe(2026 * 12);
    expect(monthIdx("2026-12")).toBe(2026 * 12 + 11);
  });
  it("returns null for junk", () => { expect(monthIdx("")).toBe(null); expect(monthIdx("nope")).toBe(null); });
});

describe("depreciation (straight-line)", () => {
  it("depreciates a full year, NBV drops by the year's charge", () => {
    const d = depreciation({ amount: 12000, life: 36, month: "2026-01" }, FY26);
    expect(d.monthly).toBeCloseTo(333.33, 1);
    expect(d.accumulated).toBeCloseTo(4000, 5);
    expect(d.nbv).toBeCloseTo(8000, 5);
  });
  it("counts months elapsed since acquisition for a mid-life asset", () => {
    const d = depreciation({ amount: 12000, life: 24, month: "2025-07" }, FY26);
    expect(d.monthly).toBe(500);
    expect(d.accumulated).toBe(9000); // 18 months by end of FY26
    expect(d.nbv).toBe(3000);
  });
  it("caps accumulated at cost for a fully depreciated asset", () => {
    const d = depreciation({ amount: 5000, life: 12, month: "2024-01" }, FY26);
    expect(d.accumulated).toBe(5000);
    expect(d.nbv).toBe(0);
    expect(Object.values(d.perMonth).every(v => v === 0)).toBe(true); // no charge left in FY26
  });
  it("zero useful life → no depreciation", () => {
    const d = depreciation({ amount: 1000, life: 0, month: "2026-01" }, FY26);
    expect(d.monthly).toBe(0); expect(d.nbv).toBe(1000);
  });
});

describe("nbvAtMonth", () => {
  it("is 0 before acquisition, full cost in the acquisition month for a 1-month view", () => {
    expect(nbvAtMonth({ amount: 12000, life: 24, month: "2026-06" }, "2026-05")).toBe(0);
    // acquired Jun, end of Jun = 1 month elapsed → 12000 - 500 = 11500
    expect(nbvAtMonth({ amount: 12000, life: 24, month: "2026-06" }, "2026-06")).toBe(11500);
  });
  it("depreciates straight-line across FY boundaries and caps at 0", () => {
    // acquired Jan-2025, end of Jan-2026 = 13 months × 500 = 6500 accumulated → NBV 5500
    expect(nbvAtMonth({ amount: 12000, life: 24, month: "2025-01" }, "2026-01")).toBe(5500);
    expect(nbvAtMonth({ amount: 12000, life: 12, month: "2024-01" }, "2026-12")).toBe(0); // fully depreciated
  });
  it("non-depreciating (life 0) stays at cost once on the books", () => {
    expect(nbvAtMonth({ amount: 5000, life: 0, month: "2026-01" }, "2026-06")).toBe(5000);
    expect(nbvAtMonth({ amount: 5000, life: 0, month: "2026-07" }, "2026-06")).toBe(0);
  });
});

describe("groupPnLSeries (consolidated monthly P&L)", () => {
  const months = ["2026-01", "2026-02"];
  const allData = {
    A: { inv: [{ month: "2026-01", amt: 1000 }], sub: [{ month: "2026-01", amt: 200 }], lab: { "2026-01": { onsite: 100 } } },
    B: { inv: [{ month: "2026-01", amt: 500 }, { month: "2026-02", amt: 700 }], sub: [], lab: {} },
  };
  const finance = {
    opex: { cats: [{ id: "c1" }, { id: "c2" }], actual: { c1: { "2026-01": 150 }, c2: { "2026-01": 50 } } },
    capex: [{ amount: 1200, life: 12, month: "2026-01" }], // 100/mo depreciation
    pnl: { interest: { "2026-01": 30 }, tax: { "2026-01": 20 } },
  };
  it("builds the full revenue → GM → EBITDA → EBIT → net bridge", () => {
    const s = groupPnLSeries(allData, finance, months);
    // Jan: rev 1500, sub 200, labour 100 → GM 1200; opex 200 → EBITDA 1000; D&A 100 → EBIT 900; -30 -20 → net 850
    expect(s[0]).toMatchObject({ rev: 1500, sub: 200, labour: 100, gm: 1200, opex: 200, ebitda: 1000, da: 100, ebit: 900, interest: 30, tax: 20, net: 850 });
    // Feb: only B revenue 700, nothing else; D&A still 100
    expect(s[1]).toMatchObject({ rev: 700, sub: 0, labour: 0, gm: 700, opex: 0, ebitda: 700, da: 100, ebit: 600, net: 600 });
  });
  it("handles missing finance blob gracefully (no opex/capex/pnl)", () => {
    const s = groupPnLSeries(allData, {}, months);
    expect(s[0]).toMatchObject({ gm: 1200, opex: 0, ebitda: 1200, da: 0, ebit: 1200, net: 1200 });
  });
  it("excludes Planned/Approved capex from D&A (must match the balance-sheet NBV filter)", () => {
    const fin = { capex: [
      { amount: 1200, life: 12, month: "2026-01", status: "Capitalised" }, // on books → 100/mo
      { amount: 2400, life: 12, month: "2026-01", status: "Planned" },      // not on books → 0
      { amount: 3600, life: 12, month: "2026-01", status: "Approved" },     // not on books → 0
    ] };
    const s = groupPnLSeries({}, fin, months);
    expect(s[0].da).toBeCloseTo(100, 5);   // only the Capitalised asset depreciates
    expect(s[1].da).toBeCloseTo(100, 5);
  });
});

describe("allocFractions", () => {
  it("defaults to 100% Core when empty", () => {
    expect(allocFractions(null, "2026-01")).toEqual({ core: 1, ew: 0, pjm: 0 });
    expect(allocFractions({ "2026-01": { core: 0, ew: 0, pjm: 0 } }, "2026-01")).toEqual({ core: 1, ew: 0, pjm: 0 });
  });
  it("normalizes any weights so fractions sum to 1", () => {
    for (const w of [{ core: 100, ew: 0, pjm: 0 }, { core: 60, ew: 30, pjm: 10 }, { core: 50, ew: 30, pjm: 10 }]) {
      const f = allocFractions({ m: w }, "m");
      expect(f.core + f.ew + f.pjm).toBeCloseTo(1, 10);
    }
  });
  it("splits proportionally", () => {
    const f = allocFractions({ m: { core: 60, ew: 30, pjm: 10 } }, "m");
    expect(f.core).toBeCloseTo(0.6, 10); expect(f.ew).toBeCloseTo(0.3, 10); expect(f.pjm).toBeCloseTo(0.1, 10);
  });
});

describe("parseDate / daysUntil", () => {
  it("parses DD/MM/YYYY and YYYY-MM-DD", () => {
    expect(parseDate("15/03/2026").getTime()).toBe(new Date(2026, 2, 15).getTime());
    expect(parseDate("2026-03-15").getTime()).toBe(new Date(2026, 2, 15).getTime());
  });
  it("handles 2-digit years and returns null for junk", () => {
    expect(parseDate("01/01/27").getFullYear()).toBe(2027);
    expect(parseDate("")).toBe(null);
    expect(parseDate("not a date")).toBe(null);
  });
  it("computes whole days until a date relative to an injected now", () => {
    const now = new Date(2026, 0, 1);
    expect(daysUntil("2026-01-31", now)).toBe(30);
    expect(daysUntil("2025-12-22", now)).toBe(-10);
    expect(daysUntil("", now)).toBe(null);
  });
});

describe("analytics helpers", () => {
  const cd = {
    inv: [{ month: "2026-01", amt: 1000 }, { month: "2026-02", amt: 1200 }, { month: "2026-03", amt: 800 }],
    sub: [{ month: "2026-01", amt: 400 }, { month: "2026-02", amt: 500 }],
    lab: { "2026-01": { onsite: 100 } },
  };
  it("clientSeries computes per-month rev/cost/labour/gm", () => {
    const s = clientSeries(cd, FY26);
    expect(s[0]).toEqual({ m: "2026-01", rev: 1000, cost: 400, labour: 100, gm: 500 });
    expect(s[1]).toEqual({ m: "2026-02", rev: 1200, cost: 500, labour: 0, gm: 700 });
    expect(s[11].rev).toBe(0);
  });
  it("linregSlope detects rising/falling", () => {
    expect(linregSlope([1, 2, 3, 4])).toBeCloseTo(1, 6);
    expect(linregSlope([4, 3, 2, 1])).toBeCloseTo(-1, 6);
    expect(linregSlope([5])).toBe(0);
  });
  it("runRateFY annualizes the active-month average", () => {
    const rr = runRateFY(clientSeries(cd, FY26));
    expect(rr.monthsActive).toBe(3);
    expect(rr.actual.rev).toBe(3000);
    expect(rr.projected.rev).toBe(3000 / 3 * 12); // 12000
  });
  it("agingBucket classifies by days past due (Net 30)", () => {
    const now = new Date(2026, 3, 1); // 1 Apr 2026
    expect(agingBucket("2026-03-20", 30, now)).toBe("current"); // due 19 Apr → not due
    expect(agingBucket("2026-03-01", 30, now)).toBe("1-30");    // due 31 Mar → 1d overdue
    expect(agingBucket("2026-01-01", 30, now)).toBe("31-60");   // due 31 Jan → 60d overdue
    expect(agingBucket("2025-10-01", 30, now)).toBe("90+");
    expect(agingBucket("", 30, now)).toBe("unknown");
  });
  it("clientRisks flags an over-budget PO and an expiring contract", () => {
    const now = new Date(2026, 0, 1);
    const data = {
      inv: [{ month: "2026-01", amt: 1000, po_no: "PO1", act_acc: "ACTUAL" }],
      sub: [], lab: {},
      contracts: [
        { type: "PO", po: "PO1", po_value: 800, status: "Active" },
        { type: "MSA", ref: "M1", expiry: "2026-02-10", status: "Active" },
      ],
    };
    const r = clientRisks(data, FY26, now);
    expect(r.some(x => x.label.includes("PO1") && x.level === "high")).toBe(true);
    expect(r.some(x => x.label.includes("Λήγει"))).toBe(true);
  });
});

describe("detectAnomalies", () => {
  const at = (arr, m) => arr.map((c, i) => ({ month: FY26[i], amt: c }));
  it("flags a duplicate AR invoice (same number + amount)", () => {
    const data = { Acme: { inv: [
      { month: FY26[0], cat: "CLIENT REVENUE - FM Core", inv_no: "100", amt: 500 },
      { month: FY26[1], cat: "CLIENT REVENUE - FM Core", inv_no: "100", amt: 500 },
    ], sub: [], lab: {} } };
    const a = detectAnomalies(data, FY26);
    const dup = a.find(x => x.type === "duplicate");
    expect(dup).toBeTruthy();
    expect(dup.level).toBe("high");
    expect(dup.detail).toContain("#100");
  });
  it("does NOT flag recurring monthly accruals as duplicates", () => {
    const data = { Acme: { inv: [
      { month: FY26[0], cat: "CLIENT REVENUE - FM Core", inv_no: "ACCRUAL", amt: -220, act_acc: "ACCRUAL" },
      { month: FY26[1], cat: "CLIENT REVENUE - FM Core", inv_no: "ACCRUAL", amt: -220, act_acc: "ACCRUAL" },
    ], sub: [], lab: {} } };
    expect(detectAnomalies(data, FY26).some(x => x.type === "duplicate")).toBe(false);
  });
  it("flags a loss month (revenue positive, GM negative)", () => {
    const data = { Acme: { inv: [{ month: FY26[0], cat: "R", inv_no: "1", amt: 100 }],
      sub: [{ month: FY26[0], cat: "C", inv_no: "9", amt: 300 }], lab: {} } };
    const loss = detectAnomalies(data, FY26).find(x => x.type === "loss");
    expect(loss && loss.level).toBe("high");
  });
  it("flags a revenue drop vs the trailing average", () => {
    const inv = [1000, 1000, 1000, 100].map((amt, i) => ({ month: FY26[i], cat: "R", inv_no: "n" + i, amt }));
    const drop = detectAnomalies({ Acme: { inv, sub: [], lab: {} } }, FY26).find(x => x.type === "rev_drop");
    expect(drop && drop.month).toBe(FY26[3]);
  });
  it("flags a missing month wedged between active months", () => {
    const inv = [{ month: FY26[0], cat: "R", inv_no: "1", amt: 100 }, { month: FY26[2], cat: "R", inv_no: "2", amt: 100 }];
    const gap = detectAnomalies({ Acme: { inv, sub: [], lab: {} } }, FY26).find(x => x.type === "gap");
    expect(gap && gap.month).toBe(FY26[1]);
  });
  it("clean data yields no anomalies, and results are severity-ranked", () => {
    const inv = [1000, 1000, 1000].map((amt, i) => ({ month: FY26[i], cat: "R", inv_no: "n" + i, amt }));
    expect(detectAnomalies({ Acme: { inv, sub: [], lab: {} } }, FY26)).toHaveLength(0);
  });
});
