// Client-side .xlsx export for the finance screens (Dashboard, Group P&L, Balance Sheet).
// Uses the xlsx lib already bundled for the import/reconcile flow. Numbers are written raw
// (rounded to 2dp) so the finance team can pivot/sum them in Excel — not as display strings.
import * as XLSX from "xlsx";

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Build one worksheet from an array-of-arrays. Strings stay strings; numbers stay numbers.
const sheetFromAoa = (aoa) => XLSX.utils.aoa_to_sheet(aoa.map(row => row.map(c => (typeof c === "number" ? r2(c) : c))));

// Write a workbook of { name -> array-of-arrays } and trigger a download.
export const exportWorkbook = (filename, sheets) => {
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, aoa }) => {
    const ws = sheetFromAoa(aoa);
    // Sheet names are capped at 31 chars and can't contain []:*?/\ — sanitize defensively.
    const safe = String(name).replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Sheet";
    XLSX.utils.book_append_sheet(wb, ws, safe);
  });
  XLSX.writeFile(wb, filename);
};
