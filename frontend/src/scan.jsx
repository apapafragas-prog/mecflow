// Document scanner: drops PDF/image/zip files, renders/extracts them, and calls the
// backend AI extraction endpoints to pre-fill invoice/contract rows. Extracted from App.jsx.
// Relies on window.pdfjsLib and window.JSZip, which App.jsx sets up at startup.
import { useState, useEffect, useRef } from "react";
import { api } from "./api.js";
import { P, MONTHS, ML, REV_CATS, COST_CATS, SVC_CATS } from "./constants.js";
import { Inp, Sel } from "./ui.jsx";
import { useT, monthLabel, catLabel } from "./i18n.jsx";

export function Scan({onAdd,onAddAR,goTo,year,client}) {
  const { t } = useT();
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [drag, setDrag] = useState(false);
  const [mode, setMode] = useState("AP"); // "AP" = Sub Invoices, "AR" = CBRE Invoices
  const [autoMode, setAutoMode] = useState(false); // bulk folder scan: auto-detect AP/AR per invoice
  const [targetMonth, setTargetMonth] = useState(""); // optional override
  const [approved, setApproved] = useState({sub:0, inv:0}); // post-approve destination summary
  const [preview, setPreview] = useState(null); // {url,name,isPdf} local-blob preview before approve

  const [libsReady, setLibsReady] = useState({pdf:false, ocr:false, zip:false});
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // pdf.js + JSZip are bundled locally (imported at module top) — instantly ready, no CDN.
  // Tesseract (rare OCR fallback) stays lazy-loaded but pinned with an SRI integrity hash.
  useEffect(() => {
    setLibsReady(p=>({...p, pdf: !!window.pdfjsLib, zip: !!window.JSZip}));
    if (window.Tesseract) { setLibsReady(p=>({...p, ocr:true})); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
    s.integrity = "sha512-2wYKf5SRmHOMuTUmSsOkTTwejJrRcL6oHK5zHw/8MPUwZgTEekmapU6UOkxs0KFy20eWWmCiL30fZoVrtRkcPQ==";
    s.crossOrigin = "anonymous";
    s.async = true;
    s.onload = () => setLibsReady(p=>({...p, ocr:true}));
    document.head.appendChild(s);
  }, []);

  // Enable folder selection on the hidden folder input (React doesn't pass webkitdirectory reliably)
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute("webkitdirectory", "");
      folderInputRef.current.setAttribute("directory", "");
    }
  }, []);

  // ── Recursive folder traversal for drag-and-drop (dataTransfer.files ignores folder contents) ──
  const readAllEntries = (reader) => new Promise((resolve) => {
    const all = [];
    const pump = () => reader.readEntries(
      (batch) => { if (!batch.length) return resolve(all); all.push(...batch); pump(); },
      () => resolve(all)
    );
    pump();
  });
  const collectEntry = async (entry, out) => {
    if (!entry) return;
    if (entry.isFile) {
      await new Promise((resolve) => entry.file((f) => { out.push(f); resolve(); }, () => resolve()));
    } else if (entry.isDirectory) {
      const entries = await readAllEntries(entry.createReader());
      for (const e of entries) await collectEntry(e, out);
    }
  };
  const filesFromDataTransfer = async (dt) => {
    // Must capture entries synchronously — dataTransfer.items is invalidated after the first await
    const items = dt && dt.items ? Array.from(dt.items) : [];
    const entries = items
      .filter((it) => it.kind === "file" && typeof it.webkitGetAsEntry === "function")
      .map((it) => it.webkitGetAsEntry())
      .filter(Boolean);
    if (!entries.length) return dt && dt.files ? Array.from(dt.files) : [];
    const out = [];
    for (const en of entries) await collectEntry(en, out);
    return out;
  };

  // Isolated throwaway pickers — a fresh input each click, so file vs folder mode can never get crossed
  const pickFiles = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = false; inp.accept = ".pdf,.zip,image/*";
    inp.style.display = "none"; document.body.appendChild(inp);
    inp.onchange = (e) => { setAutoMode(false); setFiles([]); setResults([]); setApproved({sub:0,inv:0}); addFiles(e.target.files); inp.remove(); };
    inp.click();
  };
  const pickFolder = () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true; inp.webkitdirectory = true;
    inp.style.display = "none"; document.body.appendChild(inp);
    inp.onchange = (e) => { setAutoMode(true); setFiles([]); setResults([]); setApproved({sub:0,inv:0}); addFiles(e.target.files); inp.remove(); };
    inp.click();
  };

  const isZip = f => f.name.toLowerCase().endsWith(".zip") || f.type==="application/zip" || f.type==="application/x-zip-compressed";

  const waitForLib = async (key, timeout=15000) => {
    const start = Date.now();
    while(Date.now()-start < timeout) {
      if(key==="pdf" && window.pdfjsLib) return true;
      if(key==="ocr" && window.Tesseract) return true;
      if(key==="zip" && window.JSZip) return true;
      await new Promise(r=>setTimeout(r,200));
    }
    return false;
  };

  const addFiles = async fl => {
    const incoming = Array.from(fl);
    const out = [];
    for(const f of incoming) {
      if(isZip(f)) {
        // Extract ZIP contents
        if(!window.JSZip) {
          setProg(t("Φόρτωση υποστήριξης ZIP...","Loading ZIP support..."));
          const ok = await waitForLib("zip");
          if(!ok) { alert(t("Δεν φορτώθηκε η υποστήριξη ZIP. Δοκίμασε ξανά.","ZIP support could not be loaded. Please try again.")); continue; }
          setProg("");
        }
        try {
          const zip = await window.JSZip.loadAsync(f);
          const entries = Object.values(zip.files).filter(z => !z.dir);
          for(const entry of entries) {
            const lname = entry.name.toLowerCase();
            if(lname.endsWith(".pdf")||lname.endsWith(".jpg")||lname.endsWith(".jpeg")||lname.endsWith(".png")||lname.endsWith(".gif")||lname.endsWith(".webp")) {
              const blob = await entry.async("blob");
              const ext = lname.split(".").pop();
              const mime = ext==="pdf"?"application/pdf":`image/${ext==="jpg"?"jpeg":ext}`;
              const file = new File([blob], entry.name.split("/").pop(), {type:mime});
              out.push(file);
            }
          }
        } catch(e) {
          console.error("ZIP extraction failed:",e);
          alert(t(`Αποτυχία εξαγωγής ${f.name}: ${e.message}`,`Failed to extract ${f.name}: ${e.message}`));
        }
      } else if(f.type==="application/pdf"||f.type.startsWith("image/")) {
        out.push(f);
      }
    }
    if(out.length) setFiles(p => [...p, ...out]);
  };

  // Extract text from PDF using pdf.js
  const extractPdfText = async (file) => {
    if(!window.pdfjsLib) {
      const ok = await waitForLib("pdf");
      if(!ok) throw new Error("pdf.js failed to load — check internet connection");
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
    let text = "";
    for(let i=1;i<=pdf.numPages;i++){
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it=>it.str).join(" ") + "\n";
    }
    return text;
  };

  // Render PDF page to canvas for OCR
  const pdfPageToImage = async (file, pageNum) => {
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
    const page = await pdf.getPage(pageNum || 1);
    const scale = 2; // higher = better OCR
    const vp = page.getViewport({scale});
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({canvasContext:canvas.getContext("2d"),viewport:vp}).promise;
    return canvas;
  };

  // OCR using Tesseract.js
  const ocrImage = async (imageSource, progressCb) => {
    if(!window.Tesseract) {
      const ok = await waitForLib("ocr");
      if(!ok) throw new Error("Tesseract.js failed to load — check internet connection");
    }
    const worker = await window.Tesseract.createWorker("ell+eng", 1, {
      logger: m => { if(m.status==="recognizing text" && progressCb) progressCb(Math.round(m.progress*100)); }
    });
    const {data:{text}} = await worker.recognize(imageSource);
    await worker.terminate();
    return text;
  };

  // Parse invoice data from text using regex
  const parseInvoice = (text, fileName) => {
    const t = text.replace(/\s+/g," ");
    const lines = text.split("\n").map(l=>l.trim()).filter(l=>l.length>3);
    
    // Supplier — look for company suffixes like Ε.Π.Ε., Α.Ε., Ltd, S.A.
    let supplier = "";
    const compM = t.match(/([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s.&\-,]{3,60})\s*(?:Ε\.?Π\.?Ε|Α\.?Ε|Ι\.?Κ\.?Ε|Ο\.?Ε|LTD|Ltd|S\.?A\.?|GmbH|LLC|INC|Μον[οπρόσωπη]*)/i);
    if(compM) supplier = compM[0].trim();
    if(!supplier){ const suppM = t.match(/(?:Επωνυμία|Company|Προμηθευτής|Εκδότης)[:\s]*([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s.&\-]{3,60})/i); if(suppM) supplier=suppM[1].trim(); }
    if(!supplier) supplier = lines[0]||"Unknown";
    
    // AFM
    const afmM = t.match(/(?:Α\.?Φ\.?Μ\.?|ΑΦΜ|AFM|VAT\s*(?:No|ID|:)?)\s*:?\s*(?:EL)?(\d{9})/i);
    const afm = afmM?afmM[1]:"";
    
    // Invoice number
    let invNo = "";
    const invPs = [/(?:Αρ\.?\s*(?:Τιμ[ολογίου]*|Παρ[αστατικού]*)|Αριθμ[ός]*\s*(?:Τιμ|Παρ)|Invoice\s*(?:No|#|Number)|ΤΙΜΟΛΟΓΙΟ\s*(?:No|Αρ)?|ΑΡΙΘΜΟΣ)[:\s#]*([A-Za-zΑ-Ω]*[\s\-]*\d+[A-Za-z0-9\/-]*)/i, /(?:Σειρά|Series)[:\s]*([A-Za-zΑ-Ω]+)\s*(?:Αρ|No)[:\s]*(\d+)/i, /([A-ZΑ-Ω]{2,4}[\-]\d{4,8})/];
    for(const p of invPs){const m=t.match(p);if(m){invNo=(m[2]?m[1]+"-"+m[2]:m[1]).trim();break;}}
    
    // Date
    let invDate="", month=MONTHS[0];
    const dPs = [/(?:Ημερομηνία|Date|Ημ\/νία|Ημ\.)[:\s]*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/i, /(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/];
    for(const p of dPs){const m=t.match(p);if(m){const d=m[1],mo=m[2],y=m[3].length===2?"20"+m[3]:m[3];invDate=d.padStart(2,"0")+"/"+mo.padStart(2,"0")+"/"+y;const tryM=y+"-"+mo.padStart(2,"0");month=MONTHS.includes(tryM)?tryM:MONTHS[0];break;}}
    
    // Amount parsing — handles EU format 1.234,56 and US 1,234.56
    const parseAmt = s => { if(!s)return 0; s=s.replace(/\s/g,""); if(/^\d{1,3}\.\d{3}/.test(s))s=s.replace(/\./g,"").replace(",","."); else s=s.replace(",","."); return parseFloat(s)||0; };
    
    let net=0,vat=0,total=0;
    const nPs=[/(?:ΚΑΘΑΡΗ\s*ΑΞΙΑ|Καθαρή\s*Αξία|Net\s*(?:Amount|Value)|Αξία\s*(?:προ|χωρίς)\s*ΦΠΑ|Υποσύνολο|Subtotal|Taxable)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
    const vPs=[/(?:Φ\.?\s*Π\.?\s*Α\.?\s*\d*%?|ΦΠΑ\s*\d*%?|VAT\s*\d*%?|Φόρος)[^0-9€]*€?\s*(?:[\d.,]+\s+)?([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
    const tPs=[/(?:ΠΛΗΡΩΤΕΟ|Πληρωτέο|GRAND\s*TOTAL|Grand\s*Total|Γενικό\s*Σύνολο|ΓΕΝΙΚΟ\s*ΣΥΝΟΛΟ|ΣΥΝΟΛΙΚΗ\s*ΑΞΙΑ|Total\s*Due|Amount\s*Due)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i, /(?:ΣΥΝΟΛΟ|Σύνολο|Total)[^0-9€]*€?\s*([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})/i];
    for(const p of nPs){const m=t.match(p);if(m){net=parseAmt(m[1]);break;}}
    for(const p of vPs){const m=t.match(p);if(m){vat=parseAmt(m[1]);break;}}
    for(const p of tPs){const m=t.match(p);if(m){total=parseAmt(m[1]);break;}}
    
    // Fallback: find largest number
    if(!net&&!vat&&!total){const nums=[...t.matchAll(/([\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/g)].map(m=>parseAmt(m[1])).filter(n=>n>1);if(nums.length)total=Math.max(...nums);}
    
    if(net&&vat&&!total)total=net+vat; if(total&&vat&&!net)net=total-vat; if(total&&net&&!vat&&total!==net)vat=total-net;
    // Sanity: VAT cannot be >= net (max 24% in Greece)
    if(vat>=net&&net>0){vat=0;total=0;}
    if(total&&!net&&!vat){net=Math.round(total/1.24*100)/100;vat=Math.round((total-net)*100)/100;}
    if(net&&!vat){vat=Math.round(net*0.24*100)/100;total=net+vat;}
    if(net&&total&&net===total&&!vat){vat=Math.round(net*0.24*100)/100;total=net+vat;}
    
    // Description
    let desc="";
    const dePs=[/(?:Περιγραφή|Description|Αιτιολογία|Υπηρεσ[ίες]*|ΠΕΡΙΓΡΑΦΗ|DESCRIPTION)[:\s\/]*([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s,.\-\/]{5,100})/i, /(?:για|for)\s+([A-Za-zΑ-Ωα-ωάέήίόύώϊϋΐΰ\s,.\-\/]{5,80})/i, /\b((?:Enhanced|Cleaning|Maintenance|Security|Facility|Management|Services?|Project)\s+[A-Za-z\s]{3,60})/i];
    for(const p of dePs){const m=t.match(p);if(m){desc=m[1].trim();break;}}

    return {supplier_name:supplier.slice(0,60),afm,invoice_number:invNo,invoice_date:invDate,month,net_amount:net,vat_amount:vat,total_amount:total,description:desc,cost_category:mode==="AP"?COST_CATS[0]:REV_CATS[0],service_category:"Other",_file:fileName,_st:"ready",_raw:text.slice(0,2000),_mode:mode};
  };

  // Invoice scanner — calls backend proxy (which calls Claude AI)
  // Falls back to local OCR + regex if backend AI is unavailable
  const scan = async () => {
    setBusy(true); setResults([]); setApproved({sub:0,inv:0}); const out = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setProg(t(`🤖 AI ανάγνωση ${i+1}/${files.length}: ${f.name}`,`🤖 AI reading ${i+1}/${files.length}: ${f.name}`));
      try {
        const scanMode = autoMode ? "AUTO" : mode;
        const ex = await api.extractInvoice(f, scanMode);
        const rMode = autoMode ? (String(ex.direction||"").toUpperCase()==="AR" ? "AR" : "AP") : mode;
        const isCredit = !!ex.is_credit_note;
        let net = Number(ex.net_amount)||0;
        let vat = Number(ex.vat_amount)||0;
        let total = Number(ex.total_amount)||0;
        if(isCredit) {
          if(net>0) net = -net;
          if(vat>0) vat = -vat;
          if(total>0) total = -total;
        }
        if(!total && net) total = net + (vat||net*0.24);
        if(!vat && net && total) vat = total - net;
        if(!net && total) { net = total/1.24; vat = total - net; }

        // Month: prefer ex.month, fallback to date parse
        let month = ex.month || "";
        if(!MONTHS.includes(month) && ex.invoice_date) {
          const dm = String(ex.invoice_date).match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
          if(dm){const y=dm[3].length===2?"20"+dm[3]:dm[3]; month = y+"-"+dm[2].padStart(2,"0");}
        }
        if(!MONTHS.includes(month)) month = MONTHS[0];

        // Cost/revenue category guess from description
        const desc = (ex.description||"").toLowerCase();
        let cat;
        if(rMode==="AR") {
          if(desc.includes("pjm")||desc.includes("project")) cat = REV_CATS.find(c=>c.toLowerCase().includes("pjm"))||REV_CATS[0];
          else if(desc.includes("extra")) cat = REV_CATS.find(c=>c.toLowerCase().includes("extra"))||REV_CATS[0];
          else cat = REV_CATS.find(c=>c.toLowerCase().includes("core"))||REV_CATS[0];
        } else {
          if(desc.includes("pjm")||desc.includes("project")) cat = COST_CATS.find(c=>c.toLowerCase().includes("pjm"))||COST_CATS[0];
          else if(desc.includes("extra")) cat = COST_CATS.find(c=>c.toLowerCase().includes("extra"))||COST_CATS[0];
          else cat = COST_CATS.find(c=>c.toLowerCase().includes("core"))||COST_CATS[0];
        }

        // Service category guess
        let svcCat = "Other";
        if(desc.includes("clean")||desc.includes("καθαρ")) svcCat = "Cleaning";
        else if(desc.includes("security")||desc.includes("ασφαλ")) svcCat = "Security";
        else if(desc.includes("maintenance")||desc.includes("technical")||desc.includes("hvac")) svcCat = "Building Systems operations & maintenance";
        else if(desc.includes("landscap")||desc.includes("plant")||desc.includes("κήπο")) svcCat = "Landscaping";
        else if(desc.includes("kitchen")||desc.includes("coffee")||desc.includes("καφέ")) svcCat = "Kitchen supplies";

        out.push({
          supplier_name: ex.supplier_name||"",
          afm: ex.afm||"",
          invoice_number: ex.invoice_number||"",
          invoice_date: ex.invoice_date||"",
          month,
          net_amount: net,
          vat_amount: vat,
          total_amount: total,
          description: ex.description||"",
          cost_category: cat,
          service_category: svcCat,
          _file: f.name,
          _st: "ready",
          _mode: rMode,
          _isCredit: isCredit,
          _fileObj: f
        });
      } catch(e) {
        console.error("AI extraction failed for",f.name,e);
        // Fallback: try local OCR + regex parser
        try {
          let text = "";
          if(f.type==="application/pdf"){
            text = await extractPdfText(f);
            if(text.replace(/\s/g,"").length < 30){
              const canvas = await pdfPageToImage(f, 1);
              text = await ocrImage(canvas, pct => setProg(t(`OCR εφεδρικό: ${f.name} (${pct}%)`,`OCR fallback: ${f.name} (${pct}%)`)));
            }
          } else {
            const url = URL.createObjectURL(f);
            text = await ocrImage(url, pct => setProg(t(`OCR: ${f.name} (${pct}%)`,`OCR: ${f.name} (${pct}%)`)));
            URL.revokeObjectURL(url);
          }
          const parsed = parseInvoice(text, f.name);
          parsed._mode = mode;
          parsed._fileObj = f;
          out.push(parsed);
        } catch(e2) {
          out.push({_file:f.name,_st:"error",_mode:mode,supplier_name:"EXTRACTION FAILED",net_amount:0,vat_amount:0,total_amount:0,description:String(e.message||e),cost_category:mode==="AR"?REV_CATS[0]:COST_CATS[0],service_category:"Other",month:MONTHS[0],_raw:"",_fileObj:f});
        }
      }
    }
    setResults(out); setBusy(false); setProg("");
  };

  const upd = (i,k,v) => setResults(p => p.map((r,j) => j===i?{...r,[k]:v}:r));
  const flipMode = (i) => setResults(p => p.map((r,j) => {
    if(j!==i) return r;
    const nm = (r._mode||"AP")==="AR" ? "AP" : "AR";
    return {...r, _mode:nm, cost_category: nm==="AR"?REV_CATS[0]:COST_CATS[0]};
  }));
  const approve = async (i) => {
    const r = results[i]; if(r._st!=="ready") return;
    // Use targetMonth if set, otherwise the row's month, otherwise block
    const m = targetMonth || ((r.month||"").slice(0,7));
    if(!MONTHS.includes(m)) {
      alert(t(`Αδυναμία έγκρισης "${r._file}" — μη έγκυρος μήνας "${m||"(κενό)"}"\n\nΌρισε Μήνα-στόχο παραπάνω ή διόρθωσε τον μήνα της γραμμής.`,`Cannot approve "${r._file}" — invalid month "${m||"(empty)"}"\n\nSet a Target Month above or fix this row's month dropdown.`));
      return;
    }
    // Store the original file on the NAS and link it to the entry
    let docId = r._docId || null;
    if(!docId && r._fileObj && year && client) {
      try {
        upd(i,"_st","saving");
        const up = await api.uploadFile(year, client, r._fileObj, (r._mode||mode)==="AR"?"AR Invoice":"AP Invoice", r.invoice_number||"");
        docId = up && up.id;
        upd(i,"_docId",docId);
      } catch(e) { console.warn("Invoice file upload failed:",e); }
    }
    if((r._mode||mode)==="AR") {
      const a = Number(r.net_amount)||0; const v = Number(r.vat_amount)||0;
      onAddAR && onAddAR([{site:"Site 1",month:m,cat:r.cost_category||REV_CATS[0],amt:a,vat:v,total:a+v,inv_no:r.invoice_number||"",date:r.invoice_date||"",comments:r.description||"",act_acc:"ACTUAL",po_no:"",docId}]);
    } else {
      onAdd([{site:"Site 1",month:m,cat:r.cost_category||COST_CATS[0],supplier:r.supplier_name||"",svc_cat:r.service_category||"Other",svc_desc:r.description||"",amt:Number(r.net_amount)||0,vat:Number(r.vat_amount)||0,inv_no:r.invoice_number||"",date:r.invoice_date||"",docId}]);
    }
    setApproved(a=>{const k=(r._mode||mode)==="AR"?"inv":"sub";return {...a,[k]:a[k]+1};});
    upd(i,"_st","done");
  };
  const approveAll = () => {
    if(!targetMonth && results.some(r=>r._st==="ready"&&!MONTHS.includes((r.month||"").slice(0,7)))) {
      alert(t("Κάποια τιμολόγια έχουν μη έγκυρους μήνες. Όρισε Μήνα-στόχο παραπάνω ή διόρθωσε τις γραμμές πρώτα.","Some invoices have invalid months. Please set a Target Month above or fix individual rows first."));
      return;
    }
    results.forEach((_,i) => approve(i));
  };
  const setAllMonth = (m) => setResults(p=>p.map(r=>({...r,month:m})));
  const [showRaw,setShowRaw] = useState(null);

  return (
    <div>
      <h2 style={{color:P.em,fontSize:16,fontWeight:700,margin:"0 0 6px"}}>{t("Σαρωτής Τιμολογίων — με AI","Invoice Scanner — AI-Powered")}</h2>
      <p style={{fontSize:13,color:P.tm,margin:"0 0 12px"}}>{t("Ρίξε τιμολόγια (PDF, εικόνες, ZIP). Το Claude διαβάζει κάθε τιμολόγιο απευθείας — χωρίς regex/OCR μαντεψιές. Ανιχνεύει πιστωτικά και εφαρμόζει αρνητικά ποσά.","Drop invoices (PDF, images, ZIP). Claude reads each invoice directly — no regex, no OCR guesswork. Auto-detects credit notes and applies negative amounts.")}</p>

      {/* Libraries status */}
      <div style={{display:"flex",gap:10,fontSize:11,marginBottom:10,color:P.tm}}>
        <span>{libsReady.pdf?"✓":"⏳"} {t("Ανάλυση PDF","PDF parser")}</span>
        <span>{libsReady.ocr?"✓":"⏳"} {t("Μηχανή OCR","OCR engine")}</span>
        <span>{libsReady.zip?"✓":"⏳"} {t("Υποστήριξη ZIP","ZIP support")}</span>
        {(!libsReady.pdf||!libsReady.ocr||!libsReady.zip) && <span style={{color:"#F57F17"}}>{t("Φόρτωση βιβλιοθηκών από CDN...","Loading libraries from CDN...")}</span>}
      </div>

      {/* Mode toggle */}
      <div style={{display:"flex",gap:0,marginBottom:14,background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:4,width:"fit-content"}}>
        <button onClick={()=>setMode("AP")} style={{background:mode==="AP"?P.em:"transparent",color:mode==="AP"?"#fff":P.tx,border:"none",padding:"8px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>📥 {t("AP — Τιμολόγια Προμηθευτών → Κόστη Υπεργ.","AP — Supplier Invoices → Sub Costs")}</button>
        <button onClick={()=>setMode("AR")} style={{background:mode==="AR"?P.em:"transparent",color:mode==="AR"?"#fff":P.tx,border:"none",padding:"8px 18px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 {t("AR — Τιμολόγια Πελατών → Έσοδα CBRE","AR — Client Invoices → CBRE Revenue")}</button>
      </div>

      <div onClick={pickFiles}
        onDrop={e=>{e.preventDefault();setDrag(false);const items=Array.from(e.dataTransfer.items||[]);const hasDir=items.some(it=>{const en=it.webkitGetAsEntry&&it.webkitGetAsEntry();return en&&en.isDirectory;});if(hasDir){alert(t("Σύρε ΑΡΧΕΙΑ (PDF/εικόνες), όχι ολόκληρο φάκελο.\n\nΓια ένα αρχείο: πάτα το κουμπί «Επιλογή αρχείου».\nΓια πολλά: διάλεξέ τα μέσα στον φάκελο και σύρ' τα μαζί.","Drag FILES (PDF/images), not a whole folder.\n\nFor one file: click the «Select a file» button.\nFor many: select them inside the folder and drag them together."));return;}setFiles([]);setResults([]);setApproved({sub:0,inv:0});addFiles(e.dataTransfer.files);}} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
        style={{display:"block",border:"3px dashed "+(drag?P.em:P.bd),borderRadius:12,padding:"36px 20px",textAlign:"center",cursor:"pointer",background:drag?P.ep:P.wh,transition:"all .2s",marginBottom:10}}>
        <input ref={fileInputRef} type="file" multiple accept=".pdf,.zip,image/*" style={{display:"none"}} onChange={e=>{addFiles(e.target.files);e.target.value="";}} />
        <input ref={folderInputRef} type="file" multiple style={{display:"none"}} onChange={e=>{addFiles(e.target.files);e.target.value="";}} />
        <div style={{fontSize:36,marginBottom:6}}>{mode==="AR"?"📤":"📥"}</div>
        <div style={{fontSize:14,fontWeight:600,color:P.em}}>{t("Ρίξε εδώ ","Drop ")}{mode==="AR"?t("τιμολόγια πελατών (AR)","client (AR) invoices"):t("τιμολόγια προμηθευτών (AP)","supplier (AP) invoices")}{t("","  here")}</div>
        <div style={{fontSize:11,color:P.tm,marginTop:4}}>{mode==="AR"?t("Θα τροφοδοτήσει Τιμολόγια CBRE (Έσοδα)","Will feed CBRE Invoices (Revenue)"):t("Θα τροφοδοτήσει Τιμολόγια Υπεργ. (Κόστη)","Will feed Sub Invoices (Costs)")} — {t("σύρε ένα ή περισσότερα αρχεία εδώ, ή διάλεξε ένα με το κουμπί","drag one or more files here, or pick a single file with the button")}</div>
      </div>
      <div style={{display:"flex",justifyContent:"center",gap:10,marginBottom:16}}>
        <button type="button" onClick={pickFiles} style={{background:P.em,color:"#fff",border:"none",padding:"10px 24px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>📄 {t("Επιλογή αρχείου","Select a file")}</button>
        <button type="button" onClick={pickFolder} style={{background:"#0277BD",color:"#fff",border:"none",padding:"10px 24px",borderRadius:6,cursor:"pointer",fontSize:13,fontWeight:700}}>📁 {t("Σάρωση φακέλου (auto AP/AR)","Scan folder (auto AP/AR)")}</button>
      </div>
      {autoMode && <div style={{textAlign:"center",marginBottom:14,padding:"8px 14px",background:"#E1F5FE",border:"1px solid #0277BD",borderRadius:6,fontSize:12,color:"#01579B",fontWeight:600}}>🔍 {t("Auto-ανίχνευση ΕΝΕΡΓΗ — κάθε τιμολόγιο ταξινομείται μόνο του σε 📥 AP (κόστος) ή 📤 AR (έσοδο). Έλεγξε/διόρθωσε το badge κάθε κάρτας (κλικ ⇄) πριν το Approve.","Auto-detect ON — each invoice self-classifies as 📥 AP (cost) or 📤 AR (revenue). Check/fix each card's badge (click ⇄) before Approve.")}</div>}
      {files.length > 0 && (
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,padding:14,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:13,fontWeight:600,color:P.em}}>{files.length} {t("αρχείο(α)","file(s)")}</span>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setFiles([]);setAutoMode(false);}} style={{background:"none",border:"1px solid "+P.bd,padding:"5px 12px",borderRadius:4,cursor:"pointer",fontSize:12}}>{t("Καθαρισμός","Clear")}</button>
              <button onClick={scan} disabled={busy} style={{background:P.em,color:"#fff",border:"none",padding:"7px 20px",borderRadius:6,cursor:busy?"wait":"pointer",fontSize:13,fontWeight:600,opacity:busy?0.5:1}}>{busy?t("Επεξεργασία AI...","AI processing..."):t("🤖 Εξαγωγή Όλων με AI","🤖 Extract All with AI")}</button>
            </div>
          </div>
          {files.map((f,i)=><div key={i} style={{display:"flex",gap:8,padding:"3px 0",fontSize:12,alignItems:"center"}}><span>{f.type.includes("pdf")?"📄":"🖼️"}</span><span style={{flex:1}}>{f.name}</span><span style={{color:P.tm}}>{(f.size/1024).toFixed(0)}KB</span><button onClick={()=>setFiles(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:P.rd,cursor:"pointer"}}>×</button></div>)}
          {prog && <div style={{marginTop:8,padding:"8px 12px",background:"#FFF8E1",borderRadius:6,fontSize:12,color:"#F57F17",fontWeight:600}}>{prog}</div>}
        </div>
      )}
      {(approved.sub>0||approved.inv>0) && (
        <div style={{background:P.gn,color:"#fff",borderRadius:8,padding:"10px 14px",marginBottom:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",fontSize:13,fontWeight:600}}>
          <span>✓ {t("Καταχωρήθηκαν:","Registered:")}</span>
          {approved.sub>0 && <span>{approved.sub} → {t("Τιμολόγια Υπεργ. (Κόστη)","Sub Invoices (Costs)")}</span>}
          {approved.inv>0 && <span>{approved.inv} → {t("Τιμολόγια CBRE (Έσοδα)","CBRE Invoices (Revenue)")}</span>}
          {approved.sub>0 && <button onClick={()=>goTo&&goTo("sub")} style={{background:"#fff",color:P.em,border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>→ {t("Τιμολόγια Υπεργ.","Sub Invoices")}</button>}
          {approved.inv>0 && <button onClick={()=>goTo&&goTo("inv")} style={{background:"#fff",color:P.em,border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>→ {t("Τιμολόγια CBRE","CBRE Invoices")}</button>}
        </div>
      )}
      {results.length > 0 && (
        <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}}>
          <div style={{background:P.ep,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:14,fontWeight:700,color:P.em}}>{t("Εξήχθησαν — Έλεγχος & Έγκριση","Extracted — Review & Approve")}</span>
            <button onClick={approveAll} style={{background:P.gn,color:"#fff",border:"none",padding:"7px 18px",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>✓ {t("Έγκριση Όλων","Approve All")} ({results.filter(r=>r._st==="ready").length})</button>
          </div>
          {results.map((r,i) => (
            <div key={i} style={{padding:"12px 16px",borderBottom:"1px solid "+P.bd,background:r._st==="done"?"#E8F5E9":r._st==="error"?"#FFEBEE":i%2===0?P.wh:P.al}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,color:P.tm}}>{r._file}</span>
                  <button onClick={()=>r._st==="ready"&&flipMode(i)} title={t("Κλικ για εναλλαγή AP/AR","Click to toggle AP/AR")} style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",border:"none",cursor:r._st==="ready"?"pointer":"default",background:(r._mode||"AP")==="AR"?"#0277BD":"#00897B"}}>{(r._mode||"AP")==="AR"?"📤 AR":"📥 AP"}{r._st==="ready"?" ⇄":""}</button>
                  <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",background:r._st==="done"?P.gn:r._st==="error"?P.rd:r._st==="rejected"?P.rd:P.em}}>{r._st==="done"?t("✓ ΕΓΚΡΙΘΗΚΕ","✓ APPROVED"):r._st==="saving"?t("⏳ ΑΠΟΘΗΚΕΥΣΗ…","⏳ SAVING…"):r._st==="error"?t("ΣΦΑΛΜΑ","ERROR"):r._st==="rejected"?t("✗ ΑΠΟΡΡΙΦΘΗΚΕ","✗ REJECTED"):t("ΕΤΟΙΜΟ","READY")}</span>
                  {r.afm&&<span style={{fontSize:10,color:P.tm}}>ΑΦΜ: {r.afm}</span>}
                </div>
                <div style={{display:"flex",gap:6}}>
                  {r._fileObj && <button onClick={()=>setPreview({url:URL.createObjectURL(r._fileObj),name:r._file,isPdf:(r._fileObj.type||"").includes("pdf")||(r._file||"").toLowerCase().endsWith(".pdf")})} style={{background:"none",border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:10}}>👁 {t("Προεπισκόπηση","Preview")}</button>}
                  <button onClick={()=>setShowRaw(showRaw===i?null:i)} style={{background:"none",border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:10}}>📋 Raw</button>
                  {r._st==="ready" && <button onClick={()=>approve(i)} style={{background:P.gn,color:"#fff",border:"none",padding:"4px 12px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✓ {t("Έγκριση","Approve")}</button>}
                  {r._st==="ready" && <button onClick={()=>setResults(p=>p.map((x,j)=>j===i?{...x,_st:"rejected"}:x))} style={{background:P.rd,color:"#fff",border:"none",padding:"4px 10px",borderRadius:4,cursor:"pointer",fontSize:12,fontWeight:600}}>✗ {t("Απόρριψη","Reject")}</button>}
                  {r._st==="rejected" && <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,color:"#fff",background:P.rd}}>✗ {t("ΑΠΟΡΡΙΦΘΗΚΕ","REJECTED")}</span>}
                  {r._st==="rejected" && <button onClick={()=>setResults(p=>p.map((x,j)=>j===i?{...x,_st:"ready"}:x))} style={{background:"none",border:"1px solid "+P.bd,padding:"3px 8px",borderRadius:4,cursor:"pointer",fontSize:10}}>↩ {t("Αναίρεση","Undo")}</button>}
                </div>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8,fontSize:12}}>
                <Inp l={(r._mode||"AP")==="AR"?t("Πελάτης","Client"):t("Προμηθευτής","Supplier")} v={r.supplier_name||""} set={v=>upd(i,"supplier_name",v)} w={160} />
                <Inp l={t("Αρ. Τιμολ.","Invoice #")} v={r.invoice_number||""} set={v=>upd(i,"invoice_number",v)} w={90} />
                <Inp l={t("Ημ/νία","Date")} v={r.invoice_date||""} set={v=>upd(i,"invoice_date",v)} w={90} />
                <Sel l={t("Μήνας","Month")} v={(r.month||"").slice(0,7)} set={v=>upd(i,"month",v)} opts={MONTHS.map(m=>({v:m,l:monthLabel(m)}))} w={100} />
                <Inp l={t("Καθαρό €","Net €")} v={r.net_amount||0} set={v=>upd(i,"net_amount",parseFloat(v)||0)} w={80} t="number" />
                <Inp l={t("ΦΠΑ €","VAT €")} v={r.vat_amount||0} set={v=>upd(i,"vat_amount",parseFloat(v)||0)} w={70} t="number" />
                <Inp l={t("Σύνολο €","Total €")} v={r.total_amount||0} set={v=>upd(i,"total_amount",parseFloat(v)||0)} w={80} t="number" />
                {(r._mode||"AP")==="AR" ? (
                  <Sel l={t("Κατηγορία Εσόδων","Revenue Category")} v={r.cost_category||REV_CATS[0]} set={v=>upd(i,"cost_category",v)} opts={REV_CATS.map(c=>({v:c,l:catLabel(c)}))} w={220} />
                ) : (
                  <>
                    <Sel l={t("Κατ. Κόστους","Cost Cat")} v={r.cost_category||COST_CATS[0]} set={v=>upd(i,"cost_category",v)} opts={COST_CATS.map(c=>({v:c,l:catLabel(c)}))} w={190} />
                    <Sel l={t("Υπηρεσία","Service")} v={r.service_category||"Other"} set={v=>upd(i,"service_category",v)} opts={SVC_CATS.map(c=>({v:c,l:catLabel(c)}))} w={160} />
                  </>
                )}
                <Inp l={t("Περιγραφή","Description")} v={r.description||""} set={v=>upd(i,"description",v)} w={180} />
              </div>
              {showRaw===i && r._raw && (
                <div style={{marginTop:8,padding:10,background:"#f5f5f5",borderRadius:6,fontSize:10,fontFamily:"monospace",maxHeight:150,overflow:"auto",whiteSpace:"pre-wrap",color:P.tm}}>{r._raw}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {preview && (
        <div onClick={()=>{ if(preview.url) URL.revokeObjectURL(preview.url); setPreview(null); }} style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div onClick={e=>e.stopPropagation()} style={{background:P.wh,borderRadius:10,width:"90%",maxWidth:900,height:"88vh",display:"flex",flexDirection:"column",overflow:"hidden",boxShadow:"0 20px 60px rgba(0,0,0,.3)"}}>
            <div style={{background:P.em,color:"#fff",padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:700,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>👁 {preview.name}</span>
              <button onClick={()=>{ if(preview.url) URL.revokeObjectURL(preview.url); setPreview(null); }} style={{background:"rgba(255,255,255,.2)",border:"none",color:"#fff",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:14,fontWeight:700}}>✕</button>
            </div>
            <div style={{flex:1,overflow:"auto",background:"#525659",display:"flex",alignItems:"center",justifyContent:"center"}}>
              {preview.isPdf
                ? <iframe title="preview" src={preview.url} style={{width:"100%",height:"100%",border:"none"}} />
                : <img alt="preview" src={preview.url} style={{maxWidth:"100%",maxHeight:"100%"}} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
