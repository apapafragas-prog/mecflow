// Company-wide (consolidated) monthly reports for finance/admin:
//   • Group P&L   — all clients' revenue/cost/labour + company OPEX/CAPEX → GM → EBITDA → EBIT → Net.
//   • Balance Sheet — monthly closing balances per account. Fixed assets (NBV), trade AR/AP and
//     retained earnings are auto-derived from the data; the rest are maintained by hand.
// P&L manual rows (interest/tax) and the balance-sheet accounts live in the finance_data blob
// (same store as OPEX/CAPEX) — we load the whole blob and save it back, preserving opex/capex.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, YEARS, uid, fmt, fPct } from "./constants.js";
import { groupPnLSeries, nbvAtMonth } from "./calc.js";

const grossAmt = r => Number(r.total) || ((Number(r.amt) || 0) + (Number(r.vat) || 0)) || Number(r.amt) || 0;
const isPaid = r => r.paid === "paid" || r.paid === true;

const mkDefaultBS = () => ({
  accounts: [
    { id: uid(), section: "asset", label: "Ταμείο & Τράπεζες" },
    { id: uid(), section: "asset", label: "Λοιπές απαιτήσεις / Προκαταβολές" },
    { id: uid(), section: "liability", label: "Τραπεζικός δανεισμός" },
    { id: uid(), section: "liability", label: "ΦΠΑ / Φόροι πληρωτέοι" },
    { id: uid(), section: "liability", label: "Δεδουλευμένα / Λοιπές υποχρεώσεις" },
    { id: uid(), section: "equity", label: "Μετοχικό κεφάλαιο" },
    { id: uid(), section: "equity", label: "Αποθεματικά / Κέρδη εις νέον (έναρξη)" },
  ],
  values: {},
});

const SECTIONS = [
  { k: "asset", l: "ΕΝΕΡΓΗΤΙΚΟ (Assets)" },
  { k: "liability", l: "ΥΠΟΧΡΕΩΣΕΙΣ (Liabilities)" },
  { k: "equity", l: "ΙΔΙΑ ΚΕΦΑΛΑΙΑ (Equity)" },
];

export function GroupReports({ year, setYear, user, onBack, onLogout }) {
  const [allData, setAllData] = useState({});
  const [fin, setFin] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("pnl");       // pnl | bs
  const [saveState, setSaveState] = useState("idle");
  const [na, setNa] = useState({ label: "", section: "asset" });
  const verRef = useRef(0);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false; setLoaded(false);
    (async () => {
      const [cd, fr] = await Promise.all([
        api.getYearData(year).catch(() => ({})),
        api.getFinanceData(year).catch(() => null),
      ]);
      if (cancelled) return;
      setAllData(cd || {});
      verRef.current = (fr && fr.version) || 0;
      const d = (fr && fr.data) || {};
      if (!d.pnl) d.pnl = {};
      if (!d.pnl.interest) d.pnl.interest = {};
      if (!d.pnl.tax) d.pnl.tax = {};
      if (!d.bs || !Array.isArray(d.bs.accounts) || !d.bs.accounts.length) d.bs = mkDefaultBS();
      if (!d.bs.values) d.bs.values = {};
      setFin(d); dirtyRef.current = false; setSaveState("idle"); setLoaded(true);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line
  }, [year]);

  // Auto-save the whole finance blob (opex/capex preserved because we loaded it all).
  useEffect(() => {
    if (!loaded || !fin || !dirtyRef.current) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try { const r = await api.saveFinanceData(year, fin, verRef.current); verRef.current = (r && r.version) || verRef.current + 1; dirtyRef.current = false; setSaveState("saved"); }
      catch (e) { setSaveState("error"); console.warn("group finance save failed", e); }
    }, 600);
    return () => clearTimeout(t);
  // eslint-disable-next-line
  }, [fin, loaded, year]);

  const mutate = (fn) => { dirtyRef.current = true; setFin(p => { const n = JSON.parse(JSON.stringify(p)); fn(n); return n; }); };

  const series = loaded ? groupPnLSeries(allData, fin, MONTHS) : MONTHS.map(m => ({ m, rev: 0, sub: 0, labour: 0, gm: 0, opex: 0, ebitda: 0, da: 0, ebit: 0, interest: 0, tax: 0, net: 0 }));
  const byMonth = Object.fromEntries(series.map(r => [r.m, r]));
  const ytd = k => series.reduce((s, r) => s + (r[k] || 0), 0);

  const setPnl = (kind, m, v) => mutate(n => { if (!n.pnl[kind]) n.pnl[kind] = {}; n.pnl[kind][m] = parseFloat(v) || 0; });

  // ── Balance-sheet derived lines (read-only) ──
  const nbvByMonth = {}, arByMonth = {}, apByMonth = {}, cumNet = {};
  let run = 0;
  const idx = m => MONTHS.indexOf(m);
  MONTHS.forEach(m => {
    let nbv = 0; (fin?.capex || []).forEach(it => { nbv += nbvAtMonth(it, m); }); nbvByMonth[m] = nbv;
    let ar = 0, ap = 0;
    Object.values(allData || {}).forEach(cd => {
      (cd?.inv || []).forEach(i => { const im = idx(i.month); if (!isPaid(i) && im >= 0 && im <= idx(m)) ar += grossAmt(i); });
      (cd?.sub || []).forEach(i => { const im = idx(i.month); if (!isPaid(i) && im >= 0 && im <= idx(m)) ap += grossAmt(i); });
    });
    arByMonth[m] = ar; apByMonth[m] = ap;
    run += byMonth[m]?.net || 0; cumNet[m] = run;
  });
  const DERIVED = [
    { section: "asset", label: "Πάγια — Αναπόσβεστη αξία (NBV)", fn: m => nbvByMonth[m] },
    { section: "asset", label: "Απαιτήσεις πελατών (AR, ανοιχτά)", fn: m => arByMonth[m] },
    { section: "liability", label: "Υποχρεώσεις προμηθευτών (AP, ανοιχτά)", fn: m => apByMonth[m] },
    { section: "equity", label: "Αποτέλεσμα περιόδου (σωρευτικά)", fn: m => cumNet[m] },
  ];

  const accts = fin?.bs?.accounts || [];
  const bsVal = (id, m) => fin?.bs?.values?.[id]?.[m] ?? "";
  const setBsVal = (id, m, v) => mutate(n => { if (!n.bs.values[id]) n.bs.values[id] = {}; n.bs.values[id][m] = parseFloat(v) || 0; });
  const renameAcct = (id, l) => mutate(n => { const a = n.bs.accounts.find(x => x.id === id); if (a) a.label = l; });
  const delAcct = (id) => { if (!confirm("Διαγραφή λογαριασμού και των τιμών του;")) return; mutate(n => { n.bs.accounts = n.bs.accounts.filter(a => a.id !== id); delete n.bs.values[id]; }); };
  const addAcct = () => { const l = na.label.trim(); if (!l) return; mutate(n => n.bs.accounts.push({ id: uid(), section: na.section, label: l })); setNa({ label: "", section: na.section }); };

  const manualIn = sec => accts.filter(a => a.section === sec);
  const derivedIn = sec => DERIVED.filter(d => d.section === sec);
  const sectionTotal = (sec, m) => manualIn(sec).reduce((s, a) => s + (Number(fin?.bs?.values?.[a.id]?.[m]) || 0), 0) + derivedIn(sec).reduce((s, d) => s + d.fn(m), 0);
  const totalAssets = m => sectionTotal("asset", m);
  const totalLE = m => sectionTotal("liability", m) + sectionTotal("equity", m);
  const check = m => totalAssets(m) - totalLE(m);
  const acctTotal = id => MONTHS.reduce((s, m) => s + (Number(fin?.bs?.values?.[id]?.[m]) || 0), 0);

  const thS = { padding: "6px 8px", textAlign: "center", fontSize: 10, fontWeight: 700, color: "#fff", background: P.em, whiteSpace: "nowrap" };
  const inpS = { width: "100%", padding: "4px 5px", border: "1px solid " + P.bd, borderRadius: 3, fontSize: 11, textAlign: "right", background: P.ip, outline: "none", boxSizing: "border-box" };
  const saveLbl = saveState === "saving" ? "💾 Saving…" : saveState === "saved" ? "✓ Saved" : saveState === "error" ? "⚠ Save failed" : "";

  // ── P&L rows ──
  const R = [
    { k: "rev", l: "Έσοδα (Revenue)" },
    { k: "sub", l: "Κόστος υπεργολάβων", cost: true },
    { k: "labour", l: "Κόστος εργασίας (Labour)", cost: true },
    { k: "gm", l: "Μικτό Κέρδος (Gross Margin)", b: true, hl: P.ep },
    { pct: true, num: "gm", den: "rev", l: "GM %", muted: true },
    { k: "opex", l: "Λειτουργικά έξοδα (OPEX)", cost: true },
    { k: "ebitda", l: "EBITDA", b: true, hl: "#C8E6C9" },
    { pct: true, num: "ebitda", den: "rev", l: "EBITDA %", muted: true },
    { k: "da", l: "Αποσβέσεις (D&A)", cost: true },
    { k: "ebit", l: "EBIT (Λειτουργικό αποτέλεσμα)", b: true, hl: P.ep },
    { k: "interest", l: "Τόκοι / χρηματοοικονομικά", cost: true, edit: true },
    { k: "tax", l: "Φόροι", cost: true, edit: true },
    { k: "net", l: "Καθαρό Αποτέλεσμα (Net)", b: true, hl: "#C8E6C9" },
    { pct: true, num: "net", den: "rev", l: "Καθαρό %", muted: true },
  ];
  const cellNum = (r, m) => {
    const row = byMonth[m] || {};
    if (r.pct) { const d = row[r.den]; return d ? row[r.num] / d : null; }
    return row[r.k] || 0;
  };
  const ytdNum = (r) => { if (r.pct) { const d = ytd(r.den); return d ? ytd(r.num) / d : null; } return ytd(r.k); };
  const showCell = (r, v) => r.pct ? fPct(v) : fmt(v);

  const kpi = (l, v, c, pct) => (
    <div style={{ background: P.wh, border: "1px solid " + P.bd, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: P.tm }}>{l}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: c, marginTop: 4 }}>{pct ? fPct(v) : "€" + fmt(v)}</div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: P.of, fontFamily: "Segoe UI,Tahoma,sans-serif" }}>
      <div style={{ background: P.em, color: "#fff", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontWeight: 800, fontSize: 20, letterSpacing: 1 }}>CBRE</span>
          <button onClick={onBack} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>◀ Clients</button>
          <span style={{ fontSize: 14, fontWeight: 600, borderLeft: "1px solid rgba(255,255,255,.3)", paddingLeft: 12 }}>🏢 Group P&amp;L / Balance Sheet — {year}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
          <span style={{ fontSize: 11, opacity: .9, minWidth: 78, textAlign: "right" }}>{saveLbl}</span>
          <span style={{ opacity: .7 }}>{user.name}</span>
          <button onClick={onLogout} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", padding: "5px 14px", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>Logout</button>
        </div>
      </div>

      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "18px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            {YEARS.map(y => (<button key={y} onClick={() => setYear(y)} style={{ padding: "6px 16px", border: year === y ? "2px solid " + P.em : "1px solid " + P.bd, borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: year === y ? 700 : 400, background: year === y ? P.em : P.wh, color: year === y ? "#fff" : P.tx }}>{y}</button>))}
          </div>
          <div style={{ display: "flex", gap: 0, background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, padding: 4 }}>
            {[{ v: "pnl", l: "📈 P&L (Group)" }, { v: "bs", l: "⚖️ Balance Sheet" }].map(t => (
              <button key={t.v} onClick={() => setTab(t.v)} style={{ background: tab === t.v ? P.em : "transparent", color: tab === t.v ? "#fff" : P.tx, border: "none", padding: "7px 20px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>{t.l}</button>
            ))}
          </div>
        </div>

        {!loaded && <div style={{ padding: 40, textAlign: "center", color: P.tm }}>Loading…</div>}

        {/* ── GROUP P&L ── */}
        {loaded && tab === "pnl" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 12, marginBottom: 16 }}>
              {kpi("Revenue (YTD)", ytd("rev"), P.gn)}
              {kpi("Gross Margin (YTD)", ytd("gm"), ytd("gm") >= 0 ? P.gn : P.rd)}
              {kpi("EBITDA (YTD)", ytd("ebitda"), ytd("ebitda") >= 0 ? P.em : P.rd)}
              {kpi("EBITDA %", ytd("rev") ? ytd("ebitda") / ytd("rev") : null, P.em, true)}
              {kpi("Καθαρό (YTD)", ytd("net"), ytd("net") >= 0 ? P.gn : P.rd)}
            </div>
            <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1250 }}>
                <colgroup><col style={{ width: 230 }} />{MONTHS.map(m => <col key={m} style={{ width: 72 }} />)}<col style={{ width: 100 }} /></colgroup>
                <thead><tr>
                  <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #00695C" }}>Γραμμή</th>
                  {MONTHS.map(m => <th key={m} style={thS}>{ML[m]}</th>)}
                  <th style={{ ...thS, background: "#00695C" }}>YTD</th>
                </tr></thead>
                <tbody>
                  {R.map((r, i) => {
                    const yv = ytdNum(r);
                    return (
                      <tr key={r.l + i} style={{ background: r.hl || (r.muted ? "#FAFBFA" : i % 2 === 0 ? P.wh : P.al) }}>
                        <td style={{ padding: "6px 10px", fontSize: r.muted ? 11 : 12, fontStyle: r.muted ? "italic" : "normal", fontWeight: r.b ? 700 : 400, color: r.muted ? P.tm : r.b ? P.em : P.tx, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap" }}>{r.l}</td>
                        {MONTHS.map(m => {
                          if (r.edit) return (
                            <td key={m} style={{ padding: "3px 4px", borderBottom: "1px solid " + P.bd }}>
                              <input type="number" step="0.01" value={fin?.pnl?.[r.k]?.[m] ?? ""} onChange={e => setPnl(r.k, m, e.target.value)} style={inpS} />
                            </td>
                          );
                          const v = cellNum(r, m);
                          const neg = typeof v === "number" && v < 0;
                          return <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: r.b ? 700 : 400, color: r.muted ? P.tm : neg ? P.rd : r.b ? P.em : r.cost ? "#8a5a00" : P.tx, borderBottom: "1px solid " + P.bd }}>{v == null ? "-" : showCell(r, v)}</td>;
                        })}
                        <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: (typeof yv === "number" && yv < 0) ? P.rd : P.em, background: r.hl ? "#C8E6C9" : "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{yv == null ? "-" : showCell(r, yv)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
              Ενοποιημένο για <b>όλους τους πελάτες</b> ({Object.keys(allData || {}).length}) + εταιρικά OPEX/CAPEX. Τα κόστη εμφανίζονται θετικά· τα υποσύνολα (GM, EBITDA, EBIT, Καθαρό) είναι τα καθαρά αποτελέσματα.
              <b> EBITDA</b> = Μικτό Κέρδος − OPEX. <b>EBIT</b> = EBITDA − Αποσβέσεις. Τόκοι &amp; Φόροι καταχωρούνται χειροκίνητα (αποθηκεύονται αυτόματα).
            </div>
          </div>
        )}

        {/* ── BALANCE SHEET ── */}
        {loaded && tab === "bs" && (
          <div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
              <select value={na.section} onChange={e => setNa(x => ({ ...x, section: e.target.value }))} style={{ padding: "6px 10px", border: "1px solid " + P.bd, borderRadius: 6, fontSize: 12, outline: "none" }}>
                {SECTIONS.map(s => <option key={s.k} value={s.k}>{s.l}</option>)}
              </select>
              <input value={na.label} onChange={e => setNa(x => ({ ...x, label: e.target.value }))} onKeyDown={e => e.key === "Enter" && addAcct()} placeholder="Νέος λογαριασμός…" style={{ padding: "6px 10px", border: "1px solid " + P.bd, borderRadius: 6, fontSize: 12, outline: "none", width: 220 }} />
              <button onClick={addAcct} style={{ background: P.em, color: "#fff", border: "none", padding: "6px 14px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ Λογαριασμός</button>
            </div>
            <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", minWidth: 1250 }}>
                <colgroup><col style={{ width: 230 }} />{MONTHS.map(m => <col key={m} style={{ width: 72 }} />)}<col style={{ width: 100 }} /><col style={{ width: 34 }} /></colgroup>
                <thead><tr>
                  <th style={{ ...thS, textAlign: "left", borderRight: "2px solid #00695C" }}>Λογαριασμός</th>
                  {MONTHS.map(m => <th key={m} style={thS}>{ML[m]}</th>)}
                  <th style={{ ...thS, background: "#00695C" }}>Τέλος έτους</th><th style={thS}></th>
                </tr></thead>
                <tbody>
                  {SECTIONS.map(sec => (
                    <SectionBlock key={sec.k} sec={sec} derived={derivedIn(sec.k)} manual={manualIn(sec.k)}
                      bsVal={bsVal} setBsVal={setBsVal} renameAcct={renameAcct} delAcct={delAcct} acctTotal={acctTotal}
                      sectionTotal={sectionTotal} inpS={inpS} />
                  ))}
                  {/* Balance check */}
                  <tr style={{ background: "#263238" }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #00695C" }}>Σ Ενεργητικό</td>
                    {MONTHS.map(m => <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#A5D6A7" }}>{fmt(totalAssets(m))}</td>)}
                    <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: "#A5D6A7", borderLeft: "2px solid #00695C" }}>{fmt(totalAssets(MONTHS[MONTHS.length - 1]))}</td>
                    <td style={{ background: "#263238" }}></td>
                  </tr>
                  <tr style={{ background: "#37474F" }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: "#fff", borderRight: "2px solid #00695C" }}>Σ Υποχρ. + Ίδια Κεφ.</td>
                    {MONTHS.map(m => <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: "#90CAF9" }}>{fmt(totalLE(m))}</td>)}
                    <td style={{ padding: "6px 8px", textAlign: "right", fontSize: 12, fontWeight: 700, color: "#90CAF9", borderLeft: "2px solid #00695C" }}>{fmt(totalLE(MONTHS[MONTHS.length - 1]))}</td>
                    <td style={{ background: "#37474F" }}></td>
                  </tr>
                  <tr style={{ background: P.ep }}>
                    <td style={{ padding: "8px 10px", fontSize: 12, fontWeight: 700, color: P.em, borderRight: "2px solid #00695C" }}>Έλεγχος (πρέπει = 0)</td>
                    {MONTHS.map(m => { const c = check(m); const ok = Math.abs(c) < 1; return <td key={m} style={{ padding: "6px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: ok ? P.gn : P.rd }} title={ok ? "Ισοσκελισμένο" : "Διαφορά — συμπλήρωσε ταμείο/opening balances"}>{ok ? "✓" : fmt(c)}</td>; })}
                    <td style={{ borderLeft: "2px solid #00695C", background: P.ep }}></td>
                    <td style={{ background: P.ep }}></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: P.tm, marginTop: 8, lineHeight: 1.6 }}>
              Τιμές = <b>υπόλοιπο τέλους κάθε μήνα</b>. Οι <i>auto</i> γραμμές (Πάγια/AR/AP/Αποτέλεσμα) υπολογίζονται από τα δεδομένα και είναι read-only.
              Οι υπόλοιπες (ταμείο, δάνεια, κεφάλαιο, opening balances) καταχωρούνται χειροκίνητα. Ο «Έλεγχος» δείχνει τη διαφορά Ενεργητικού − (Υποχρεώσεις + Ίδια Κεφάλαια)· συμπλήρωσε ταμείο/opening balances ώσπου να μηδενίσει.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// One balance-sheet section (Assets / Liabilities / Equity): heading, auto-derived rows,
// editable manual rows, then the section subtotal.
function SectionBlock({ sec, derived, manual, bsVal, setBsVal, renameAcct, delAcct, acctTotal, sectionTotal, inpS }) {
  return (
    <>
      <tr style={{ background: "#00695C" }}>
        <td colSpan={MONTHS.length + 3} style={{ padding: "6px 10px", fontSize: 12, fontWeight: 700, color: "#fff" }}>{sec.l}</td>
      </tr>
      {derived.map((d, i) => (
        <tr key={"d" + i} style={{ background: "#F1F5F3" }}>
          <td style={{ padding: "5px 10px", fontSize: 11.5, fontStyle: "italic", color: P.tm, borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd, whiteSpace: "nowrap" }}>{d.label} <span style={{ fontSize: 9, background: P.ep, color: P.em, padding: "0 5px", borderRadius: 6, fontStyle: "normal", fontWeight: 700 }}>auto</span></td>
          {MONTHS.map(m => { const v = d.fn(m); return <td key={m} style={{ padding: "5px 6px", textAlign: "right", fontSize: 11, color: v ? P.tx : P.tm, borderBottom: "1px solid " + P.bd }}>{v ? fmt(v) : "-"}</td>; })}
          <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.em, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{fmt(d.fn(MONTHS[MONTHS.length - 1]))}</td>
          <td style={{ borderBottom: "1px solid " + P.bd }}></td>
        </tr>
      ))}
      {manual.map((a, i) => (
        <tr key={a.id} style={{ background: i % 2 === 0 ? P.wh : P.al }}>
          <td style={{ padding: "3px 6px", borderBottom: "1px solid " + P.bd, borderRight: "2px solid " + P.bd }}>
            <input value={a.label} onChange={e => renameAcct(a.id, e.target.value)} style={{ width: "100%", border: "none", background: "transparent", fontSize: 11.5, outline: "none" }} />
          </td>
          {MONTHS.map(m => (
            <td key={m} style={{ padding: "3px 4px", borderBottom: "1px solid " + P.bd }}>
              <input type="number" step="0.01" value={bsVal(a.id, m)} onChange={e => setBsVal(a.id, m, e.target.value)} style={inpS} />
            </td>
          ))}
          <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 600, color: P.em, background: "#f5f5f5", borderLeft: "2px solid " + P.bd, borderBottom: "1px solid " + P.bd }}>{fmt(acctTotal(a.id))}</td>
          <td style={{ textAlign: "center", borderBottom: "1px solid " + P.bd }}><button onClick={() => delAcct(a.id)} style={{ background: "none", border: "none", color: P.rd, cursor: "pointer", fontSize: 14 }}>×</button></td>
        </tr>
      ))}
      <tr style={{ background: P.ep }}>
        <td style={{ padding: "6px 10px", fontSize: 11.5, fontWeight: 700, color: P.em, borderRight: "2px solid #00695C" }}>Σύνολο {sec.l.split(" ")[0]}</td>
        {MONTHS.map(m => <td key={m} style={{ padding: "5px 6px", textAlign: "right", fontSize: 11, fontWeight: 700, color: P.em }}>{fmt(sectionTotal(sec.k, m))}</td>)}
        <td style={{ padding: "5px 8px", textAlign: "right", fontSize: 11, fontWeight: 700, color: P.em, background: "#C8E6C9", borderLeft: "2px solid #00695C" }}>{fmt(sectionTotal(sec.k, MONTHS[MONTHS.length - 1]))}</td>
        <td style={{ background: P.ep }}></td>
      </tr>
    </>
  );
}
