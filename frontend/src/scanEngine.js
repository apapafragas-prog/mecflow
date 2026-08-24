// Invoice-extraction engine (no React). Pulled out of scan.jsx so the scan loop can run at the
// App level and survive tab/client navigation. Relies on window.pdfjsLib / window.JSZip /
// window.Tesseract (set up by App at startup, Tesseract lazy-loaded by the Scan view).
import { api } from "./api.js";
import { MONTHS, REV_CATS, COST_CATS } from "./constants.js";

const isZip = (f) => f.name.toLowerCase().endsWith(".zip") || f.type === "application/zip" || f.type === "application/x-zip-compressed";

const waitForLib = async (key, timeout = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (key === "pdf" && window.pdfjsLib) return true;
    if (key === "ocr" && window.Tesseract) return true;
    if (key === "zip" && window.JSZip) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
};

// Expand a FileList into scannable File objects (unzips archives, keeps pdf/image only).
export const expandFiles = async (fileList, onProg) => {
  const incoming = Array.from(fileList || []);
  const out = [];
  for (const f of incoming) {
    if (isZip(f)) {
      if (!window.JSZip) { onProg && onProg("Loading ZIP support…"); if (!(await waitForLib("zip"))) { onProg && onProg(""); continue; } onProg && onProg(""); }
      try {
        const zip = await window.JSZip.loadAsync(f);
        const entries = Object.values(zip.files).filter(z => !z.dir);
        for (const entry of entries) {
          const lname = entry.name.toLowerCase();
          if (/\.(pdf|jpg|jpeg|png|gif|webp)$/.test(lname)) {
            const blob = await entry.async("blob");
            const ext = lname.split(".").pop();
            const mime = ext === "pdf" ? "application/pdf" : `image/${ext === "jpg" ? "jpeg" : ext}`;
            out.push(new File([blob], entry.name.split("/").pop(), { type: mime }));
          }
        }
      } catch (e) { console.error("ZIP extraction failed:", e); }
    } else if (f.type === "application/pdf" || (f.type || "").startsWith("image/")) {
      out.push(f);
    }
  }
  return out;
};

const extractPdfText = async (file) => {
  if (!window.pdfjsLib && !(await waitForLib("pdf"))) throw new Error("pdf.js failed to load");
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
  }
  return text;
};

const pdfPageToImage = async (file, pageNum) => {
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const page = await pdf.getPage(pageNum || 1);
  const vp = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width; canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  return canvas;
};

const ocrImage = async (imageSource, progressCb) => {
  if (!window.Tesseract && !(await waitForLib("ocr"))) throw new Error("Tesseract.js failed to load");
  const worker = await window.Tesseract.createWorker("ell+eng", 1, {
    logger: m => { if (m.status === "recognizing text" && progressCb) progressCb(Math.round(m.progress * 100)); }
  });
  const { data: { text } } = await worker.recognize(imageSource);
  await worker.terminate();
  return text;
};

// Regex fallback parser (used only if the AI extraction endpoint is unavailable).
const parseInvoice = (text, fileName, mode) => {
  const t = text.replace(/\s+/g, " ");
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 3);
  let supplier = "";
  const compM = t.match(/([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s.&\-,]{3,60})\s*(?:Ε\.?Π\.?Ε|Α\.?Ε|Ι\.?Κ\.?Ε|Ο\.?Ε|LTD|Ltd|S\.?A\.?|GmbH|LLC|INC|Μον[οπρόσωπη]*)/i);
  if (compM) supplier = compM[0].trim();
  if (!supplier) { const suppM = t.match(/(?:Επωνυμία|Company|Προμηθευτής|Εκδότης)[:\s]*([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s.&\-]{3,60})/i); if (suppM) supplier = suppM[1].trim(); }
  if (!supplier) supplier = lines[0] || "Unknown";
  const afmM = t.match(/(?:Α\.?Φ\.?Μ\.?|ΑΦΜ|AFM|VAT\s*(?:No|ID|:)?)\s*:?\s*(?:EL)?(\d{9})/i);
  const afm = afmM ? afmM[1] : "";
  let invNo = "";
  const invPs = [/(?:Αρ\.?\s*(?:Τιμ[ολογίου]*|Παρ[αστατικού]*)|Αριθμ[ός]*\s*(?:Τιμ|Παρ)|Invoice\s*(?:No|#|Number)|ΤΙΜΟΛΟΓΙΟ\s*(?:No|Αρ)?|ΑΡΙΘΜΟΣ)[:\s#]*([A-Za-zΑ-Ω]*[\s\-]*\d+[A-Za-z0-9\/-]*)/i, /(?:Σειρά|Series)[:\s]*([A-Za-zΑ-Ω]+)\s*(?:Αρ|No)[:\s]*(\d+)/i, /([A-ZΑ-Ω]{2,4}[\-]\d{4,8})/];
  for (const p of invPs) { const m = t.match(p); if (m) { invNo = (m[2] ? m[1] + "-" + m[2] : m[1]).trim(); break; } }
  let invDate = "", month = MONTHS[0];
  const dPs = [/(?:Ημερομηνία|Date|Ημ\/νία|Ημ\.)[:\s]*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/i, /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/];
  for (const p of dPs) { const m = t.match(p); if (m) { const d = m[1], mo = m[2], y = m[3].length === 2 ? "20" + m[3] : m[3]; invDate = d.padStart(2, "0") + "/" + mo.padStart(2, "0") + "/" + y; const tryM = y + "-" + mo.padStart(2, "0"); month = MONTHS.includes(tryM) ? tryM : MONTHS[0]; break; } }
  const parseAmt = s => { if (!s) return 0; s = s.replace(/\s/g, ""); if (/^\d{1,3}\.\d{3}/.test(s)) s = s.replace(/\./g, "").replace(",", "."); else s = s.replace(",", "."); return parseFloat(s) || 0; };
  let net = 0, vat = 0, total = 0;
  const nPs = [/(?:ΚΑΘΑΡΗ\s*ΑΞΙΑ|Καθαρή\s*Αξία|Net\s*(?:Amount|Value)|Αξία\s*(?:προ|χωρίς)\s*ΦΠΑ|Υποσύνολο|Subtotal|Taxable)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
  const vPs = [/(?:Φ\.?\s*Π\.?\s*Α\.?\s*\d*%?|ΦΠΑ\s*\d*%?|VAT\s*\d*%?|Φόρος)[^0-9€]*€?\s*(?:[\d.,]+\s+)?([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
  const tPs = [/(?:ΠΛΗΡΩΤΕΟ|Πληρωτέο|GRAND\s*TOTAL|Grand\s*Total|Γενικό\s*Σύνολο|ΓΕΝΙΚΟ\s*ΣΥΝΟΛΟ|ΣΥΝΟΛΙΚΗ\s*ΑΞΙΑ|Total\s*Due|Amount\s*Due)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i, /(?:ΣΥΝΟΛΟ|Σύνολο|Total)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
  for (const p of nPs) { const m = t.match(p); if (m) { net = parseAmt(m[1]); break; } }
  for (const p of vPs) { const m = t.match(p); if (m) { vat = parseAmt(m[1]); break; } }
  for (const p of tPs) { const m = t.match(p); if (m) { total = parseAmt(m[1]); break; } }
  if (!net && !vat && !total) { const nums = [...t.matchAll(/([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/g)].map(m => parseAmt(m[1])).filter(n => n > 1); if (nums.length) total = Math.max(...nums); }
  if (net && vat && !total) total = net + vat; if (total && vat && !net) net = total - vat; if (total && net && !vat && total !== net) vat = total - net;
  if (vat >= net && net > 0) { vat = 0; total = 0; }
  if (total && !net && !vat) { net = Math.round(total / 1.24 * 100) / 100; vat = Math.round((total - net) * 100) / 100; }
  if (net && !vat) { vat = Math.round(net * 0.24 * 100) / 100; total = net + vat; }
  if (net && total && net === total && !vat) { vat = Math.round(net * 0.24 * 100) / 100; total = net + vat; }
  let desc = "";
  const dePs = [/(?:Περιγραφή|Description|Αιτιολογία|Υπηρεσ[ίες]*|ΠΕΡΙΓΡΑΦΗ|DESCRIPTION)[:\s\/]*([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s,.\-\/]{5,100})/i, /(?:για|for)\s+([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s,.\-\/]{5,80})/i, /\b((?:Enhanced|Cleaning|Maintenance|Security|Facility|Management|Services?|Project)\s+[A-Za-z\s]{3,60})/i];
  for (const p of dePs) { const m = t.match(p); if (m) { desc = m[1].trim(); break; } }
  return { supplier_name: supplier.slice(0, 60), afm, invoice_number: invNo, invoice_date: invDate, month, net_amount: net, vat_amount: vat, total_amount: total, description: desc, cost_category: mode === "AP" ? COST_CATS[0] : REV_CATS[0], service_category: "Other", _file: fileName, _st: "ready", _raw: text.slice(0, 2000), _mode: mode };
};

// Extract ONE file → a normalized result row. AI first, OCR+regex fallback on failure.
export const extractOne = async (f, mode, autoMode, onProg) => {
  try {
    const scanMode = autoMode ? "AUTO" : mode;
    const ex = await api.extractInvoice(f, scanMode);
    const rMode = autoMode ? (String(ex.direction || "").toUpperCase() === "AR" ? "AR" : "AP") : mode;
    const isCredit = !!ex.is_credit_note;
    let net = Number(ex.net_amount) || 0, vat = Number(ex.vat_amount) || 0, total = Number(ex.total_amount) || 0;
    if (isCredit) { if (net > 0) net = -net; if (vat > 0) vat = -vat; if (total > 0) total = -total; }
    if (!total && net) total = net + (vat || net * 0.24);
    if (!vat && net && total) vat = total - net;
    if (!net && total) { net = total / 1.24; vat = total - net; }
    // Prefer the invoice DATE's month (ground truth for a single scanned invoice) over the AI's
    // separate "month" guess — otherwise the same invoice can land in a different month than its date.
    let month = "";
    if (ex.invoice_date) {
      const dm = String(ex.invoice_date).match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
      if (dm) { const y = dm[3].length === 2 ? "20" + dm[3] : dm[3]; month = y + "-" + dm[2].padStart(2, "0"); }
    }
    if (!MONTHS.includes(month)) month = ex.month || "";   // fall back to the AI-provided month
    if (!MONTHS.includes(month)) month = MONTHS[0];
    const desc = (ex.description || "").toLowerCase();
    const pick = (list) => desc.includes("pjm") || desc.includes("project") ? (list.find(c => c.toLowerCase().includes("pjm")) || list[0])
      : desc.includes("extra") ? (list.find(c => c.toLowerCase().includes("extra")) || list[0])
      : (list.find(c => c.toLowerCase().includes("core")) || list[0]);
    const cat = pick(rMode === "AR" ? REV_CATS : COST_CATS);
    let svcCat = "Other";
    if (desc.includes("clean") || desc.includes("καθαρ")) svcCat = "Cleaning";
    else if (desc.includes("security") || desc.includes("ασφαλ")) svcCat = "Security services";
    else if (desc.includes("maintenance") || desc.includes("technical") || desc.includes("hvac")) svcCat = "Building Systems & maintenance";
    else if (desc.includes("landscap") || desc.includes("plant") || desc.includes("κήπο")) svcCat = "Landscaping";
    else if (desc.includes("kitchen") || desc.includes("coffee") || desc.includes("καφέ")) svcCat = "Kitchen supplies";
    return { supplier_name: ex.supplier_name || "", afm: ex.afm || "", invoice_number: ex.invoice_number || "", invoice_date: ex.invoice_date || "", month, net_amount: net, vat_amount: vat, total_amount: total, description: ex.description || "", cost_category: cat, service_category: svcCat, _file: f.name, _st: "ready", _mode: rMode, _isCredit: isCredit, _fileObj: f };
  } catch (e) {
    console.error("AI extraction failed for", f.name, e);
    try {
      let text = "";
      if (f.type === "application/pdf") {
        text = await extractPdfText(f);
        if (text.replace(/\s/g, "").length < 30) { const canvas = await pdfPageToImage(f, 1); text = await ocrImage(canvas, pct => onProg && onProg(`OCR: ${f.name} (${pct}%)`)); }
      } else {
        const url = URL.createObjectURL(f);
        text = await ocrImage(url, pct => onProg && onProg(`OCR: ${f.name} (${pct}%)`));
        URL.revokeObjectURL(url);
      }
      const parsed = parseInvoice(text, f.name, mode);
      parsed._mode = mode; parsed._fileObj = f;
      return parsed;
    } catch (e2) {
      return { _file: f.name, _st: "error", _mode: mode, supplier_name: "EXTRACTION FAILED", net_amount: 0, vat_amount: 0, total_amount: 0, description: String(e.message || e), cost_category: mode === "AR" ? REV_CATS[0] : COST_CATS[0], service_category: "Other", month: MONTHS[0], _raw: "", _fileObj: f };
    }
  }
};
