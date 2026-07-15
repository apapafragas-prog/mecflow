// Lightweight bilingual (EL/EN) layer. Each call site carries BOTH translations
// inline — t("Ελληνικά", "English") — so a string can never be left half-translated
// and there is no central keymap to keep in sync.
//
// - React usage: const { t, lang, setLang } = useT();  t("Πελάτες","Clients")
// - Module-scope usage (constants, non-hook code): import { tr } from "./i18n.jsx"
//   tr() reads the same current language the provider keeps in sync.
import { createContext, useContext, useState, useCallback } from "react";

const LS_KEY = "cbre_lang";
export const getLang = () => { try { return localStorage.getItem(LS_KEY) === "en" ? "en" : "el"; } catch { return "el"; } };

// Module-level mirror of the active language so non-React helpers (tr, monthLabel,
// enum translators) resolve without a hook. Kept in sync by LangProvider.
let CUR = getLang();
export const tr = (el, en) => (CUR === "en" ? (en ?? el) : el);

const LangCtx = createContext({ lang: "el", t: (el) => el, setLang: () => {} });

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(getLang());
  CUR = lang;
  const setLang = useCallback((l) => {
    const v = l === "en" ? "en" : "el";
    CUR = v;
    try { localStorage.setItem(LS_KEY, v); } catch { /* private mode */ }
    setLangState(v);
    try { document.documentElement.lang = v; } catch { /* SSR guard */ }
  }, []);
  const t = useCallback((el, en) => (lang === "en" ? (en ?? el) : el), [lang]);
  return <LangCtx.Provider value={{ lang, t, setLang }}>{children}</LangCtx.Provider>;
}

export const useT = () => useContext(LangCtx);

// ── Month abbreviation in the active language (e.g. "2026-03" → "Mar-26" / "Μαρ-26") ──
const MON_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_EL = ["Ιαν", "Φεβ", "Μαρ", "Απρ", "Μαϊ", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"];
export const monthLabel = (ym) => {
  const m = /^(\d{4})-(\d{2})/.exec(String(ym || ""));
  if (!m) return ym;
  const names = CUR === "en" ? MON_EN : MON_EL;
  return `${names[+m[2] - 1]}-${m[1].slice(2)}`;
};

// ── Enum display translators (stored value stays canonical; only the label changes) ──
const REPORT_STATUS_EL = { draft: "Πρόχειρο", submitted: "Υποβλήθηκε από Χρήστη", approved: "Εγκρίθηκε από Finance", rejected: "Απορρίφθηκε — Διόρθωση" };
export const statusLabel = (v, fallbackEn) => (CUR === "en" ? (fallbackEn ?? v) : (REPORT_STATUS_EL[v] ?? fallbackEn ?? v));

// Revenue / cost / service / capex category display names. Keys are the canonical
// (stored) English strings; values are the Greek display. English shows the key as-is.
const CAT_EL = {
  // Revenue
  "CLIENT REVENUE - FM Core": "ΕΣΟΔΑ ΠΕΛΑΤΗ - FM Core",
  "CLIENT REVENUE - FM Extra Works": "ΕΣΟΔΑ ΠΕΛΑΤΗ - Πρόσθετες Εργασίες",
  "CLIENT REVENUE - PJMs": "ΕΣΟΔΑ ΠΕΛΑΤΗ - Έργα (PJMs)",
  // Cost
  "Subcontractors cost - FM Core": "Κόστος Υπεργολάβων - FM Core",
  "Subcontractors cost - FM Extra Works": "Κόστος Υπεργολάβων - Πρόσθετες Εργασίες",
  "Subcontractors cost - PJMs": "Κόστος Υπεργολάβων - Έργα (PJMs)",
  // Services
  "Cleaning": "Καθαρισμός", "Building Systems & maintenance": "Συστήματα Κτιρίου & Συντήρηση",
  "Waste Management": "Διαχείριση Απορριμμάτων", "Handyman services": "Υπηρεσίες Τεχνικού",
  "Office supplies": "Αναλώσιμα Γραφείου", "Kitchen supplies": "Αναλώσιμα Κουζίνας",
  "Water supplies": "Προμήθεια Νερού", "Small works": "Μικροεργασίες", "Laundry services": "Υπηρεσίες Πλυντηρίου",
  "Mail services": "Ταχυδρομικές Υπηρεσίες", "Pest Control": "Απεντόμωση", "Landscaping": "Κηποτεχνία",
  "Security services": "Υπηρεσίες Ασφαλείας", "Catering services": "Υπηρεσίες Catering",
  "Employee Convenience": "Παροχές Εργαζομένων", "Other": "Άλλο",
  // Capex
  "IT Equipment": "Εξοπλισμός IT", "Furniture & Fixtures": "Έπιπλα & Εξοπλισμός", "Vehicles": "Οχήματα",
  "Leasehold improvements": "Βελτιώσεις Μισθωμένων", "Software (capitalised)": "Λογισμικό (κεφαλαιοπ.)",
  "Machinery": "Μηχανήματα",
};
export const catLabel = (c) => (CUR === "en" ? c : (CAT_EL[c] ?? c));
