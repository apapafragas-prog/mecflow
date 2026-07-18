// Reusable leaf UI components, extracted from App.jsx. Shared by every screen.
import { useState } from "react";
import { P, fmt, logoUrl, logoUrl2 } from "./constants.js";
import { useT } from "./i18n.jsx";

// EL/EN language switch. `dark` variant for the emerald headers, light for the login card.
export function LangToggle({ dark }) {
  const { lang, setLang } = useT();
  const on = dark ? "rgba(255,255,255,.9)" : P.em, onTx = dark ? P.em : "#fff";
  const off = dark ? "rgba(255,255,255,.15)" : "transparent", offTx = dark ? "#fff" : P.tm;
  const bd = dark ? "rgba(255,255,255,.3)" : P.bd;
  return (
    <div style={{ display: "inline-flex", border: "1px solid " + bd, borderRadius: 6, overflow: "hidden" }}>
      {[["el", "ΕΛ"], ["en", "EN"]].map(([v, l]) => (
        <button key={v} onClick={() => setLang(v)} title={v === "el" ? "Ελληνικά" : "English"}
          style={{ background: lang === v ? on : off, color: lang === v ? onTx : offTx, border: "none",
            padding: "4px 9px", fontSize: 11, fontWeight: 700, cursor: "pointer", lineHeight: 1.4 }}>{l}</button>
      ))}
    </div>
  );
}

// Real company logo (Clearbit → Google favicon → colored-initials avatar on error).
export function LogoImg({name,size,radius}) {
  const nm = name || "?";
  const [src,setSrc] = useState(logoUrl(nm));
  const [err,setErr] = useState(0);
  const fallback = () => { if(err===0){setSrc(logoUrl2(nm));setErr(1);} else setErr(2); };
  const sz = size||36; const rd = radius||8;
  const color = (() => {const colors=["#003F2D","#00695C","#00897B","#0277BD","#1565C0","#283593","#4527A0","#6A1B9A","#AD1457","#C62828","#D84315","#EF6C00","#F9A825","#2E7D32","#00838F","#37474F"];let h=0;for(let i=0;i<nm.length;i++)h=((h<<5)-h+nm.charCodeAt(i))|0;return colors[Math.abs(h)%colors.length];})();
  const ini = nm.split(/[\s-]+/).map(w=>w[0]).join("").slice(0,2).toUpperCase();
  if(err>=2||!src) return <div style={{width:sz,height:sz,borderRadius:rd,background:color,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:700,fontSize:sz*0.36,flexShrink:0}}>{ini}</div>;
  return <img src={src} alt="" style={{width:sz,height:sz,borderRadius:rd,objectFit:"contain",background:"#f5f5f5",padding:2,flexShrink:0}} onError={fallback} />;
}

// Password input with a show/hide (👁) toggle. Reused on login + change-password screens.
export function PwField({value,onChange,onEnter,style,autoFocus,onFocus,onBlur}) {
  const [show,setShow] = useState(false);
  return (
    <div style={{position:"relative"}}>
      <input type={show?"text":"password"} value={value} onChange={onChange} autoFocus={autoFocus}
        onFocus={onFocus} onBlur={onBlur}
        onKeyDown={onEnter?e=>{if(e.key==="Enter")onEnter();}:undefined}
        style={{...style, paddingRight:40}} />
      <button type="button" tabIndex={-1} onMouseDown={e=>e.preventDefault()} onClick={()=>setShow(s=>!s)}
        title={show?"Απόκρυψη κωδικού":"Εμφάνιση κωδικού"} aria-label={show?"Απόκρυψη κωδικού":"Εμφάνιση κωδικού"}
        style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",fontSize:16,opacity:.55,padding:0,lineHeight:1}}>{show?"🙈":"👁"}</button>
    </div>
  );
}

// Minimal, XSS-safe markdown (bold + bullets + line breaks) — never injects model HTML.
export function MdText({text}) {
  const inline = (s)=> s.split(/(\*\*[^*]+\*\*)/g).map((p,j)=> /^\*\*[^*]+\*\*$/.test(p)?<strong key={j}>{p.slice(2,-2)}</strong>:<span key={j}>{p}</span>);
  return <>{String(text||"").split("\n").map((ln,i)=>{
    if(!ln.trim()) return <div key={i} style={{height:6}} />;
    if(/^\s*[-•]\s+/.test(ln)) return <div key={i} style={{display:"flex",gap:6,paddingLeft:2}}><span style={{color:P.em}}>•</span><span>{inline(ln.replace(/^\s*[-•]\s+/,""))}</span></div>;
    return <div key={i}>{inline(ln)}</div>;
  })}</>;
}

// Labelled text/number input (number uses text input to avoid spinner arrows).
export function Inp({l,v,set,w,t="text"}) {
  const isNum = t === "number";
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <input
        type="text"
        inputMode={isNum?"decimal":"text"}
        value={v}
        onChange={e=>set(e.target.value)}
        onBlur={isNum?e=>{const n=parseFloat(String(e.target.value).replace(",","."));if(!isNaN(n))set(n);}:undefined}
        style={{padding:"5px 7px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none",textAlign:isNum?"right":"left"}}
      />
    </div>
  );
}

// Labelled select.
export function Sel({l,v,set,opts,w}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,width:w}}>
      <label style={{fontSize:10,color:P.tm,fontWeight:600}}>{l}</label>
      <select value={v} onChange={e=>set(e.target.value)} style={{padding:"5px 7px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,background:P.ip,outline:"none"}}>{opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select>
    </div>
  );
}

// Editable data grid with Excel-like cell selection (Sum/Avg/Min/Max on numeric selections).
export function Tbl({cols,data,del,onEdit}) {
  const [fl,sF] = useState("");
  const [sel,setSel] = useState(new Set());
  const [anchor,setAnchor] = useState(null);
  const [dragging,setDragging] = useState(false);
  const rows = data.filter(r => !fl || cols.some(c => String(r[c.k]||"").toLowerCase().includes(fl.toLowerCase())));
  const cs = {padding:"5px 6px",border:"1px solid "+P.bd,borderRadius:3,fontSize:11,background:P.ip,outline:"none",width:"100%",boxSizing:"border-box"};
  const up = (id,k,v) => { if(onEdit) onEdit(id,k,v); };
  const ck = (ri,ci) => ri+":"+ci;
  const gv = (ri,ci) => { const r=rows[ri]; const c=cols[ci]; return r&&c?r[c.k]:null; };
  const md = (ri,ci,e) => { if(e.shiftKey&&anchor){const[ar,ac]=anchor;const s=new Set();for(let r=Math.min(ar,ri);r<=Math.max(ar,ri);r++) for(let c=Math.min(ac,ci);c<=Math.max(ac,ci);c++) s.add(ck(r,c));setSel(s);}else{setAnchor([ri,ci]);setSel(new Set([ck(ri,ci)]));setDragging(true);}};
  const me = (ri,ci) => { if(!dragging||!anchor)return;const[ar,ac]=anchor;const s=new Set();for(let r=Math.min(ar,ri);r<=Math.max(ar,ri);r++) for(let c=Math.min(ac,ci);c<=Math.max(ac,ci);c++) s.add(ck(r,c));setSel(s);};
  const mu = () => setDragging(false);
  const vals=[];sel.forEach(k=>{const[ri,ci]=k.split(":").map(Number);const v=gv(ri,ci);if(typeof v==="number"&&!isNaN(v))vals.push(v);});
  const sum=vals.reduce((s,v)=>s+v,0);const avg=vals.length?sum/vals.length:0;
  return (
    <div style={{background:P.wh,borderRadius:8,border:"1px solid "+P.bd,overflow:"hidden"}} onMouseUp={mu} onMouseLeave={mu}>
      <div style={{padding:"8px 12px",borderBottom:"1px solid "+P.bd,display:"flex",alignItems:"center",gap:12}}>
        <input placeholder="Filter..." value={fl} onChange={e=>sF(e.target.value)} style={{padding:"5px 8px",border:"1px solid "+P.bd,borderRadius:4,fontSize:12,outline:"none",width:180}} />
        <span style={{fontSize:11,color:P.tm}}>{rows.length} rows</span>
        {sel.size>1&&<button onClick={()=>setSel(new Set())} style={{background:"none",border:"none",color:P.tm,cursor:"pointer",fontSize:11,textDecoration:"underline"}}>Clear</button>}
      </div>
      <div style={{overflowX:"auto",userSelect:"none"}}>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr>{cols.map(c=><th key={c.k} style={{padding:"7px 10px",fontSize:11,fontWeight:700,color:"#fff",background:P.em,textAlign:c.a||"left",whiteSpace:"nowrap",position:"sticky",top:0,zIndex:2}}>{c.l}</th>)}<th style={{padding:7,fontSize:11,color:"#fff",background:P.em,width:30,position:"sticky",top:0,zIndex:2}}></th></tr></thead>
          <tbody>{rows.map((r,ri)=><tr key={r.id||ri}>{cols.map((c,ci)=>{const v=r[c.k];const isSel=sel.has(ck(ri,ci));const bg=isSel?"#E3F2FD":ri%2===0?P.wh:P.al;const bd=isSel?"2px solid #1565C0":"1px solid "+P.bd;const td={padding:"4px 6px",fontSize:12,border:bd,background:bg,textAlign:c.a||"left",minWidth:c.mw||undefined,cursor:"cell"};const h={onMouseDown:e=>md(ri,ci,e),onMouseEnter:()=>me(ri,ci)};
            if(c.opts&&onEdit) return <td key={c.k} style={td} {...h}><select value={v||""} onChange={e=>up(r.id,c.k,e.target.value)} style={{...cs,textAlign:"left"}}>{c.opts.map(o=><option key={o.v} value={o.v}>{o.l}</option>)}</select></td>;
            if(c.edit&&onEdit) return <td key={c.k} style={td} {...h}><input type="text" inputMode={c.t==="number"?"decimal":"text"} value={v??""} onChange={e=>up(r.id,c.k,c.t==="number"?e.target.value:e.target.value)} onBlur={c.t==="number"?e=>{const n=parseFloat(String(e.target.value).replace(",","."));up(r.id,c.k,isNaN(n)?0:n);}:undefined} style={{...cs,textAlign:c.a||"left"}} /></td>;
            return <td key={c.k} style={{...td,padding:"5px 10px"}} {...h}>{c.r?c.r(v,r):String(v??"")}</td>;
          })}<td style={{padding:4,textAlign:"center",border:"1px solid "+P.bd,background:ri%2===0?P.wh:P.al}}><button onClick={()=>del(r.id)} style={{background:"none",border:"none",color:P.rd,cursor:"pointer",fontSize:15}}>×</button></td></tr>)}</tbody>
        </table>
      </div>
      <div style={{background:"#263238",color:"#fff",padding:"6px 16px",display:"flex",gap:20,fontSize:12,fontFamily:"'Consolas','Courier New',monospace",minHeight:28,alignItems:"center"}}>
        {vals.length>0?(<>
          <span style={{color:"#80CBC4"}}>Cells: <b>{sel.size}</b></span>
          <span style={{color:"#B2DFDB"}}>Count: <b>{vals.length}</b></span>
          <span style={{color:"#A5D6A7"}}>Sum: <b>{fmt(sum)}</b></span>
          <span style={{color:"#C5E1A5"}}>Avg: <b>{fmt(avg)}</b></span>
          <span style={{color:"#FFCC80"}}>Min: <b>{fmt(Math.min(...vals))}</b></span>
          <span style={{color:"#EF9A9A"}}>Max: <b>{fmt(Math.max(...vals))}</b></span>
        </>):(<span style={{color:"#78909C"}}>Click or drag cells to select — Shift+click for range — numeric cells show Sum / Avg / Min / Max</span>)}
      </div>
    </div>
  );
}
