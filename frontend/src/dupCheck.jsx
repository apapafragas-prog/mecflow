// Duplicate checker — finds invoices that share an invoice number within the current client
// (across CBRE/AR and Sub/AP), so duplicates created before the reconcile dedup fix can be
// cleaned up. Rows without a number are grouped by content as "possible duplicates".
import { useMemo } from "react";
import { api } from "./api.js";
import { P, fmt } from "./constants.js";
import { useT, monthLabel } from "./i18n.jsx";

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "").trim();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const grossAmt = (r) => Number(r.total) || ((Number(r.amt) || 0) + (Number(r.vat) || 0)) || Number(r.amt) || 0;

// A real invoice number — not blank and not an accrual placeholder. Accruals recur monthly with
// the same amount, so they must key on the MONTH (content fallback), not their fake "ACCRUAL" number.
const realNo = (r) => { const no = norm(r.inv_no); return no && (r.act_acc || "").toUpperCase() !== "ACCRUAL" && no !== "accrual" && no !== "reverseaccrual"; };

// Groups of rows that share an invoice number (strong) or, when there is no real number, an identical
// content signature (month + category + amount + counterparty). `noKey` builds the number-based
// identity — for AP it includes the supplier, since suppliers can reuse invoice numbers.
function findGroups(rows, noKey) {
  const byNo = {}, byContent = {};
  rows.forEach((r) => {
    if (realNo(r)) { const k = noKey(r); (byNo[k] = byNo[k] || []).push(r); }
    else { const k = `${r.month}|${r.cat}|${round2(r.amt)}|${norm(r.supplier || r.comments)}`; (byContent[k] = byContent[k] || []).push(r); }
  });
  const strong = Object.entries(byNo).filter(([, g]) => g.length > 1).map(([no, g]) => ({ key: no, rows: g, strong: true }));
  const weak = Object.entries(byContent).filter(([, g]) => g.length > 1).map(([k, g]) => ({ key: k, rows: g, strong: false }));
  return [...strong, ...weak];
}

export function DuplicateModal({ inv, sub, setInv, setSub, year, client, onClose }) {
  const { t } = useT();
  // A duplicate = same invoice number AND same amount. Number alone would wrongly flag the separate
  // LINE ITEMS of one invoice (same number, different amounts) as duplicates.
  const invGroups = useMemo(() => findGroups(inv || [], (r) => norm(r.inv_no) + "|" + round2(r.amt)), [inv]);
  const subGroups = useMemo(() => findGroups(sub || [], (r) => norm(r.supplier) + "|" + norm(r.inv_no) + "|" + round2(r.amt)), [sub]);
  const total = invGroups.length + subGroups.length;
  const dupCount = [...invGroups, ...subGroups].reduce((s, g) => s + (g.rows.length - 1), 0);

  const del = (kind, row) => {
    if (row.docId) api.deleteFile(year, client, row.docId).catch(() => {});
    if (kind === "inv") setInv((p) => p.filter((x) => x.id !== row.id));
    else setSub((p) => p.filter((x) => x.id !== row.id));
  };

  const th = { padding: "5px 8px", textAlign: "left", fontSize: 10.5, fontWeight: 700, color: "#fff", background: P.em, whiteSpace: "nowrap" };
  const td = { padding: "5px 8px", fontSize: 11.5, borderBottom: "1px solid " + P.bd, whiteSpace: "nowrap" };

  const groupBlock = (g, kind) => (
    <div key={kind + g.key} style={{ border: "1px solid " + P.bd, borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
      <div style={{ background: g.strong ? "#FFF3E0" : "#F1F5F3", padding: "6px 12px", fontSize: 12, fontWeight: 700, color: g.strong ? "#E65100" : P.tm, display: "flex", justifyContent: "space-between" }}>
        <span>{g.strong ? t("Αρ. Τιμολ.", "Invoice #") + ": " + g.rows[0].inv_no : t("Ίδιο περιεχόμενο (χωρίς αριθμό)", "Same content (no number)")}</span>
        <span>{g.rows.length} {t("εγγραφές", "rows")}</span>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={th}>{t("Μήνας", "Month")}</th><th style={th}>{t("Ημ/νία", "Date")}</th>
          <th style={th}>{kind === "inv" ? "Site" : t("Προμηθευτής", "Supplier")}</th>
          <th style={{ ...th, textAlign: "right" }}>{t("Καθαρό €", "Net €")}</th>
          <th style={{ ...th, textAlign: "right" }}>{t("Σύνολο €", "Total €")}</th>
          <th style={th}>Act/Acc</th><th style={th}></th>
        </tr></thead>
        <tbody>{g.rows.map((r, i) => (
          <tr key={r.id || i} style={{ background: i === 0 ? "#E8F5E9" : "#fff" }}>
            <td style={td}>{monthLabel(r.month)}</td>
            <td style={td}>{r.date || "—"}</td>
            <td style={{ ...td, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }} title={kind === "inv" ? r.site : r.supplier}>{kind === "inv" ? (r.site || "—") : (r.supplier || "—")}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(Number(r.amt) || 0)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(grossAmt(r))}</td>
            <td style={td}>{r.act_acc || "ACTUAL"}</td>
            <td style={{ ...td, textAlign: "right" }}>
              {i === 0
                ? <span style={{ fontSize: 10, color: P.gn, fontWeight: 700 }}>{t("κράτα", "keep")}</span>
                : <button onClick={() => del(kind, r)} style={{ background: P.rd, color: "#fff", border: "none", padding: "3px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>× {t("Διαγραφή", "Delete")}</button>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "min(920px,100%)", height: "min(720px,100%)", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 16px 60px rgba(0,0,0,.4)", fontFamily: "Segoe UI,Tahoma,sans-serif" }}>
        <div style={{ background: P.em, color: "#fff", padding: "12px 18px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>🔍 {t("Έλεγχος διπλών", "Duplicate check")} <span style={{ fontSize: 12, opacity: .8, fontWeight: 400 }}>· {client}</span></div>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", padding: "4px 11px", borderRadius: 5, cursor: "pointer", fontSize: 15, fontWeight: 700 }}>✕</button>
        </div>
        <div style={{ padding: "10px 18px", borderBottom: "1px solid " + P.bd, background: P.of, fontSize: 12, color: P.tm }}>
          {total === 0
            ? t("Δεν βρέθηκαν διπλά 🎉", "No duplicates found 🎉")
            : t(`Βρέθηκαν ${total} ομάδες με πιθανά διπλά (${dupCount} επιπλέον εγγραφές). Η πρώτη γραμμή κάθε ομάδας σημειώνεται «κράτα» — σβήσε τις υπόλοιπες αν είναι όντως διπλές. Έλεγξε πάντα τον μήνα/ημερομηνία πριν διαγράψεις.`,
                 `Found ${total} groups of possible duplicates (${dupCount} extra rows). The first row of each group is marked "keep" — delete the rest if they are truly duplicates. Always check the month/date before deleting.`)}
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          {invGroups.length > 0 && <div style={{ fontSize: 12, fontWeight: 700, color: P.em, margin: "0 0 8px" }}>📤 {t("Τιμολόγια CBRE (AR)", "CBRE Invoices (AR)")}</div>}
          {invGroups.map((g) => groupBlock(g, "inv"))}
          {subGroups.length > 0 && <div style={{ fontSize: 12, fontWeight: 700, color: P.em, margin: "12px 0 8px" }}>📥 {t("Τιμολόγια Υπεργ. (AP)", "Sub Invoices (AP)")}</div>}
          {subGroups.map((g) => groupBlock(g, "sub"))}
          {total === 0 && <div style={{ textAlign: "center", color: P.tm, padding: 40, fontSize: 14 }}>✓ {t("Καθαρά — κανένα διπλό", "Clean — no duplicates")}</div>}
        </div>
      </div>
    </div>
  );
}
