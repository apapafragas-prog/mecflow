// Invoice scanner — a CONTROLLED VIEW over App-owned, per-client scan state.
// The heavy extraction loop lives in App (scanEngine.js) so scanning keeps running while you
// switch tabs or clients; this component just renders the current client's session + drives it
// through `scanApi`. Local state here is UI-only (drag / preview / raw toggle / Tesseract load).
import { useState, useEffect } from "react";
import { api } from "./api.js";
import { P, MONTHS, REV_CATS, COST_CATS, SVC_CATS } from "./constants.js";
import { Inp, Sel } from "./ui.jsx";
import { useT, monthLabel, catLabel } from "./i18n.jsx";

export function Scan({ session, scanApi, onAdd, onAddAR, goTo, year, client }) {
  const { t } = useT();
  const { files, results, busy, prog, mode, autoMode, approved } = session;
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState(null);
  const [showRaw, setShowRaw] = useState(null);
  const [libsReady, setLibsReady] = useState({ pdf: false, ocr: false, zip: false });

  // pdf.js + JSZip are bundled locally (instant). Tesseract (rare OCR fallback) stays lazy-loaded.
  useEffect(() => {
    setLibsReady(p => ({ ...p, pdf: !!window.pdfjsLib, zip: !!window.JSZip }));
    if (window.Tesseract) { setLibsReady(p => ({ ...p, ocr: true })); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
    s.integrity = "sha512-2wYKf5SRmHOMuTUmSsOkTTwejJrRcL6oHK5zHw/8MPUwZgTEekmapU6UOkxs0KFy20eWWmCiL30fZoVrtRkcPQ==";
    s.crossOrigin = "anonymous"; s.async = true;
    s.onload = () => setLibsReady(p => ({ ...p, ocr: true }));
    document.head.appendChild(s);
  }, []);

  // Throwaway pickers — a fresh input each click so file vs folder mode can never get crossed.
  const pickFiles = () => {
    if (busy) return;
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = false; inp.accept = ".pdf,.zip,image/*"; inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = (e) => { scanApi.resetPick(false); scanApi.addFiles(e.target.files); inp.remove(); };
    inp.click();
  };
  const pickFolder = () => {
    if (busy) return;
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true; inp.webkitdirectory = true; inp.style.display = "none";
    document.body.appendChild(inp);
    inp.onchange = (e) => { scanApi.resetPick(true); scanApi.addFiles(e.target.files); inp.remove(); };
    inp.click();
  };

  const upd = (i, k, v) => scanApi.updateResult(i, { [k]: v });
  const flipMode = (i) => scanApi.setResults(p => p.map((r, j) => {
    if (j !== i) return r;
    const nm = (r._mode || "AP") === "AR" ? "AP" : "AR";
    return { ...r, _mode: nm, cost_category: nm === "AR" ? REV_CATS[0] : COST_CATS[0] };
  }));

  const approve = async (i) => {
    const r = results[i]; if (r._st !== "ready") return;
    const m = (r.month || "").slice(0, 7);
    if (!MONTHS.includes(m)) {
      alert(t(`Αδυναμία έγκρισης "${r._file}" — μη έγκυρος μήνας "${m || "(κενό)"}"\n\nΔιόρθωσε τον μήνα της γραμμής.`, `Cannot approve "${r._file}" — invalid month "${m || "(empty)"}"\n\nFix this row's month dropdown.`));
      return;
    }
    let docId = r._docId || null;
    if (!docId && r._fileObj && year && client) {
      try {
        scanApi.updateResult(i, { _st: "saving" });
        const up = await api.uploadFile(year, client, r._fileObj, (r._mode || mode) === "AR" ? "AR Invoice" : "AP Invoice", r.invoice_number || "");
        docId = up && up.id;
        scanApi.updateResult(i, { _docId: docId });
      } catch (e) { console.warn("Invoice file upload failed:", e); }
    }
    if ((r._mode || mode) === "AR") {
      const a = Number(r.net_amount) || 0, v = Number(r.vat_amount) || 0;
      onAddAR && onAddAR([{ site: "Site 1", month: m, cat: r.cost_category || REV_CATS[0], amt: a, vat: v, total: a + v, inv_no: r.invoice_number || "", date: r.invoice_date || "", comments: r.description || "", act_acc: "ACTUAL", po_no: "", docId }]);
    } else {
      onAdd([{ site: "Site 1", month: m, cat: r.cost_category || COST_CATS[0], supplier: r.supplier_name || "", svc_cat: r.service_category || "Other", svc_desc: r.description || "", amt: Number(r.net_amount) || 0, vat: Number(r.vat_amount) || 0, inv_no: r.invoice_number || "", date: r.invoice_date || "", docId }]);
    }
    scanApi.bumpApproved((r._mode || mode) === "AR" ? "inv" : "sub");
    scanApi.updateResult(i, { _st: "done" });
  };
  const approveAll = () => {
    if (results.some(r => r._st === "ready" && !MONTHS.includes((r.month || "").slice(0, 7)))) {
      alert(t("Κάποια τιμολόγια έχουν μη έγκυρους μήνες. Διόρθωσε τις γραμμές πρώτα.", "Some invoices have invalid months. Fix the rows first."));
      return;
    }
    results.forEach((_, i) => approve(i));
  };

  return (
    <div>
      <h2 style={{ color: P.em, fontSize: 16, fontWeight: 700, margin: "0 0 6px" }}>{t("Σαρωτής Τιμολογίων — με AI", "Invoice Scanner — AI-Powered")}</h2>
      <p style={{ fontSize: 13, color: P.tm, margin: "0 0 12px" }}>{t("Ρίξε τιμολόγια (PDF, εικόνες, ZIP). Το Claude διαβάζει κάθε τιμολόγιο απευθείας. Η σάρωση συνεχίζεται στο παρασκήνιο ακόμα κι αν αλλάξεις tab ή πελάτη.", "Drop invoices (PDF, images, ZIP). Claude reads each invoice directly. Scanning continues in the background even if you switch tab or client.")}</p>

      <div style={{ display: "flex", gap: 10, fontSize: 11, marginBottom: 10, color: P.tm }}>
        <span>{libsReady.pdf ? "✓" : "⏳"} {t("Ανάλυση PDF", "PDF parser")}</span>
        <span>{libsReady.ocr ? "✓" : "⏳"} {t("Μηχανή OCR", "OCR engine")}</span>
        <span>{libsReady.zip ? "✓" : "⏳"} {t("Υποστήριξη ZIP", "ZIP support")}</span>
      </div>

      {/* Mode toggle */}
      <div style={{ display: "flex", gap: 0, marginBottom: 14, background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, padding: 4, width: "fit-content" }}>
        <button onClick={() => scanApi.setField("mode", "AP")} style={{ background: mode === "AP" ? P.em : "transparent", color: mode === "AP" ? "#fff" : P.tx, border: "none", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>📥 {t("AP — Τιμολόγια Προμηθευτών → Κόστη Υπεργ.", "AP — Supplier Invoices → Sub Costs")}</button>
        <button onClick={() => scanApi.setField("mode", "AR")} style={{ background: mode === "AR" ? P.em : "transparent", color: mode === "AR" ? "#fff" : P.tx, border: "none", padding: "8px 18px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>📤 {t("AR — Τιμολόγια Πελατών → Έσοδα CBRE", "AR — Client Invoices → CBRE Revenue")}</button>
      </div>

      <div onClick={pickFiles}
        onDrop={e => { e.preventDefault(); setDrag(false); if (busy) return; const items = Array.from(e.dataTransfer.items || []); const hasDir = items.some(it => { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); return en && en.isDirectory; }); if (hasDir) { alert(t("Σύρε ΑΡΧΕΙΑ (PDF/εικόνες), όχι ολόκληρο φάκελο.\n\nΓια φάκελο χρησιμοποίησε το κουμπί «Σάρωση φακέλου».", "Drag FILES (PDF/images), not a whole folder.\n\nFor a folder use the «Scan folder» button.")); return; } scanApi.resetPick(false); scanApi.addFiles(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        style={{ display: "block", border: "3px dashed " + (drag ? P.em : P.bd), borderRadius: 12, padding: "36px 20px", textAlign: "center", cursor: "pointer", background: drag ? P.ep : P.wh, transition: "all .2s", marginBottom: 10 }}>
        <div style={{ fontSize: 36, marginBottom: 6 }}>{mode === "AR" ? "📤" : "📥"}</div>
        <div style={{ fontSize: 14, fontWeight: 600, color: P.em }}>{t("Ρίξε εδώ ", "Drop ")}{mode === "AR" ? t("τιμολόγια πελατών (AR)", "client (AR) invoices") : t("τιμολόγια προμηθευτών (AP)", "supplier (AP) invoices")}</div>
        <div style={{ fontSize: 11, color: P.tm, marginTop: 4 }}>{mode === "AR" ? t("Θα τροφοδοτήσει Τιμολόγια CBRE (Έσοδα)", "Will feed CBRE Invoices (Revenue)") : t("Θα τροφοδοτήσει Τιμολόγια Υπεργ. (Κόστη)", "Will feed Sub Invoices (Costs)")} — {t("σύρε αρχεία εδώ ή διάλεξε με το κουμπί", "drag files here or pick with the button")}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 16 }}>
        <button type="button" onClick={pickFiles} style={{ background: P.em, color: "#fff", border: "none", padding: "10px 24px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>📄 {t("Επιλογή αρχείου", "Select a file")}</button>
        <button type="button" onClick={pickFolder} style={{ background: "#0277BD", color: "#fff", border: "none", padding: "10px 24px", borderRadius: 6, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>📁 {t("Σάρωση φακέλου (auto AP/AR)", "Scan folder (auto AP/AR)")}</button>
      </div>
      {autoMode && <div style={{ textAlign: "center", marginBottom: 14, padding: "8px 14px", background: "#E1F5FE", border: "1px solid #0277BD", borderRadius: 6, fontSize: 12, color: "#01579B", fontWeight: 600 }}>🔍 {t("Auto-ανίχνευση ΕΝΕΡΓΗ — κάθε τιμολόγιο ταξινομείται μόνο του σε 📥 AP ή 📤 AR. Έλεγξε/διόρθωσε το badge (κλικ ⇄) πριν το Approve.", "Auto-detect ON — each invoice self-classifies as 📥 AP or 📤 AR. Check/fix each badge (click ⇄) before Approve.")}</div>}

      {files.length > 0 && (
        <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: P.em }}>{files.length} {t("αρχείο(α)", "file(s)")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => scanApi.clearFiles()} disabled={busy} style={{ background: "none", border: "1px solid " + P.bd, padding: "5px 12px", borderRadius: 4, cursor: busy ? "not-allowed" : "pointer", fontSize: 12, opacity: busy ? .5 : 1 }}>{t("Καθαρισμός", "Clear")}</button>
              <button onClick={() => scanApi.run()} disabled={busy} style={{ background: P.em, color: "#fff", border: "none", padding: "7px 20px", borderRadius: 6, cursor: busy ? "wait" : "pointer", fontSize: 13, fontWeight: 600, opacity: busy ? 0.5 : 1 }}>{busy ? t("Επεξεργασία AI...", "AI processing...") : t("🤖 Εξαγωγή Όλων με AI", "🤖 Extract All with AI")}</button>
            </div>
          </div>
          {files.map((f, i) => <div key={i} style={{ display: "flex", gap: 8, padding: "3px 0", fontSize: 12, alignItems: "center" }}><span>{f.type.includes("pdf") ? "📄" : "🖼️"}</span><span style={{ flex: 1 }}>{f.name}</span><span style={{ color: P.tm }}>{(f.size / 1024).toFixed(0)}KB</span>{!busy && <button onClick={() => scanApi.removeFile(i)} style={{ background: "none", border: "none", color: P.rd, cursor: "pointer" }}>×</button>}</div>)}
          {prog && <div style={{ marginTop: 8, padding: "8px 12px", background: "#FFF8E1", borderRadius: 6, fontSize: 12, color: "#F57F17", fontWeight: 600 }}>{prog}</div>}
        </div>
      )}

      {(approved.sub > 0 || approved.inv > 0) && (
        <div style={{ background: P.gn, color: "#fff", borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 13, fontWeight: 600 }}>
          <span>✓ {t("Καταχωρήθηκαν:", "Registered:")}</span>
          {approved.sub > 0 && <span>{approved.sub} → {t("Τιμολόγια Υπεργ. (Κόστη)", "Sub Invoices (Costs)")}</span>}
          {approved.inv > 0 && <span>{approved.inv} → {t("Τιμολόγια CBRE (Έσοδα)", "CBRE Invoices (Revenue)")}</span>}
          {approved.sub > 0 && <button onClick={() => goTo && goTo("sub")} style={{ background: "#fff", color: P.em, border: "none", padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>→ {t("Τιμολόγια Υπεργ.", "Sub Invoices")}</button>}
          {approved.inv > 0 && <button onClick={() => goTo && goTo("inv")} style={{ background: "#fff", color: P.em, border: "none", padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>→ {t("Τιμολόγια CBRE", "CBRE Invoices")}</button>}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ background: P.wh, borderRadius: 8, border: "1px solid " + P.bd, overflow: "hidden" }}>
          <div style={{ background: P.ep, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: P.em }}>{t("Εξήχθησαν — Έλεγχος & Έγκριση", "Extracted — Review & Approve")}{busy ? " · " + t("σε εξέλιξη…", "in progress…") : ""}</span>
            <button onClick={approveAll} style={{ background: P.gn, color: "#fff", border: "none", padding: "7px 18px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>✓ {t("Έγκριση Όλων", "Approve All")} ({results.filter(r => r._st === "ready").length})</button>
          </div>
          {results.map((r, i) => (
            <div key={i} style={{ padding: "12px 16px", borderBottom: "1px solid " + P.bd, background: r._st === "done" ? "#E8F5E9" : r._st === "error" ? "#FFEBEE" : i % 2 === 0 ? P.wh : P.al }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: P.tm }}>{r._file}</span>
                  <button onClick={() => r._st === "ready" && flipMode(i)} title={t("Κλικ για εναλλαγή AP/AR", "Click to toggle AP/AR")} style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", border: "none", cursor: r._st === "ready" ? "pointer" : "default", background: (r._mode || "AP") === "AR" ? "#0277BD" : "#003F2D" }}>{(r._mode || "AP") === "AR" ? "📤 AR" : "📥 AP"}{r._st === "ready" ? " ⇄" : ""}</button>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", background: r._st === "done" ? P.gn : r._st === "error" ? P.rd : r._st === "rejected" ? P.rd : P.em }}>{r._st === "done" ? t("✓ ΕΓΚΡΙΘΗΚΕ", "✓ APPROVED") : r._st === "saving" ? t("⏳ ΑΠΟΘΗΚΕΥΣΗ…", "⏳ SAVING…") : r._st === "error" ? t("ΣΦΑΛΜΑ", "ERROR") : r._st === "rejected" ? t("✗ ΑΠΟΡΡΙΦΘΗΚΕ", "✗ REJECTED") : t("ΕΤΟΙΜΟ", "READY")}</span>
                  {r.afm && <span style={{ fontSize: 10, color: P.tm }}>ΑΦΜ: {r.afm}</span>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {r._fileObj && <button onClick={() => setPreview({ url: URL.createObjectURL(r._fileObj), name: r._file, isPdf: (r._fileObj.type || "").includes("pdf") || (r._file || "").toLowerCase().endsWith(".pdf") })} style={{ background: "none", border: "1px solid " + P.bd, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>👁 {t("Προεπισκόπηση", "Preview")}</button>}
                  {r._raw && <button onClick={() => setShowRaw(showRaw === i ? null : i)} style={{ background: "none", border: "1px solid " + P.bd, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>📋 Raw</button>}
                  {r._st === "ready" && <button onClick={() => approve(i)} style={{ background: P.gn, color: "#fff", border: "none", padding: "4px 12px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>✓ {t("Έγκριση", "Approve")}</button>}
                  {r._st === "ready" && <button onClick={() => scanApi.updateResult(i, { _st: "rejected" })} style={{ background: P.rd, color: "#fff", border: "none", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>✗ {t("Απόρριψη", "Reject")}</button>}
                  {r._st === "rejected" && <button onClick={() => scanApi.updateResult(i, { _st: "ready" })} style={{ background: "none", border: "1px solid " + P.bd, padding: "3px 8px", borderRadius: 4, cursor: "pointer", fontSize: 10 }}>↩ {t("Αναίρεση", "Undo")}</button>}
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 12 }}>
                <Inp l={(r._mode || "AP") === "AR" ? t("Πελάτης", "Client") : t("Προμηθευτής", "Supplier")} v={r.supplier_name || ""} set={v => upd(i, "supplier_name", v)} w={160} />
                <Inp l={t("Αρ. Τιμολ.", "Invoice #")} v={r.invoice_number || ""} set={v => upd(i, "invoice_number", v)} w={90} />
                <Inp l={t("Ημ/νία", "Date")} v={r.invoice_date || ""} set={v => upd(i, "invoice_date", v)} w={90} />
                <Sel l={t("Μήνας", "Month")} v={(r.month || "").slice(0, 7)} set={v => upd(i, "month", v)} opts={MONTHS.map(m => ({ v: m, l: monthLabel(m) }))} w={100} />
                <Inp l={t("Καθαρό €", "Net €")} v={r.net_amount || 0} set={v => upd(i, "net_amount", parseFloat(v) || 0)} w={80} t="number" />
                <Inp l={t("ΦΠΑ €", "VAT €")} v={r.vat_amount || 0} set={v => upd(i, "vat_amount", parseFloat(v) || 0)} w={70} t="number" />
                <Inp l={t("Σύνολο €", "Total €")} v={r.total_amount || 0} set={v => upd(i, "total_amount", parseFloat(v) || 0)} w={80} t="number" />
                {(r._mode || "AP") === "AR" ? (
                  <Sel l={t("Κατηγορία Εσόδων", "Revenue Category")} v={r.cost_category || REV_CATS[0]} set={v => upd(i, "cost_category", v)} opts={REV_CATS.map(c => ({ v: c, l: catLabel(c) }))} w={220} />
                ) : (
                  <>
                    <Sel l={t("Κατ. Κόστους", "Cost Cat")} v={r.cost_category || COST_CATS[0]} set={v => upd(i, "cost_category", v)} opts={COST_CATS.map(c => ({ v: c, l: catLabel(c) }))} w={190} />
                    <Sel l={t("Υπηρεσία", "Service")} v={r.service_category || "Other"} set={v => upd(i, "service_category", v)} opts={SVC_CATS.map(c => ({ v: c, l: catLabel(c) }))} w={160} />
                  </>
                )}
                <Inp l={t("Περιγραφή", "Description")} v={r.description || ""} set={v => upd(i, "description", v)} w={180} />
              </div>
              {showRaw === i && r._raw && (
                <div style={{ marginTop: 8, padding: 10, background: "#f5f5f5", borderRadius: 6, fontSize: 10, fontFamily: "monospace", maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", color: P.tm }}>{r._raw}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div onClick={() => { if (preview.url) URL.revokeObjectURL(preview.url); setPreview(null); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: P.wh, borderRadius: 10, width: "90%", maxWidth: 900, height: "88vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
            <div style={{ background: P.em, color: "#fff", padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>👁 {preview.name}</span>
              <button onClick={() => { if (preview.url) URL.revokeObjectURL(preview.url); setPreview(null); }} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflow: "auto", background: "#525659", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {preview.isPdf
                ? <iframe title="preview" src={preview.url} style={{ width: "100%", height: "100%", border: "none" }} />
                : <img alt="preview" src={preview.url} style={{ maxWidth: "100%", maxHeight: "100%" }} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
