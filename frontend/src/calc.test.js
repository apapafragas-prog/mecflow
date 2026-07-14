import { describe, it, expect } from "vitest";
import { monthIdx, depreciation, allocFractions, parseDate, daysUntil } from "./calc.js";

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
