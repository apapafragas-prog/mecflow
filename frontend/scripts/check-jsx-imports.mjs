// Dependency-free guard: catch JSX components that are used but never imported or
// defined in the same file. ESLint core `no-undef` does NOT flag `<Foo/>` (that needs
// eslint-plugin-react), and Vite's build happily bundles a missing component into a
// runtime crash. This closes that gap — it caught real regressions during the L-05 split
// (finance.jsx missing Inp/Sel, clientPicker.jsx missing AdminPanel).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

// Capitalised identifiers that are ambient (no import needed).
const AMBIENT = new Set(["React", "Fragment"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.jsx$/.test(name)) out.push(p);
  }
  return out;
}

let problems = 0;
for (const file of walk(SRC)) {
  const code = readFileSync(file, "utf8");
  // JSX opening tags with a capitalised name, excluding member expressions (<a.b/>).
  const used = new Set();
  for (const m of code.matchAll(/<([A-Z][A-Za-z0-9_]*)(?=[\s/>])/g)) used.add(m[1]);
  for (const name of used) {
    if (AMBIENT.has(name)) continue;
    const defined =
      new RegExp(`\\b(function|const|let|var)\\s+${name}\\b`).test(code) || // local def
      new RegExp(`\\bimport\\b[^;]*\\b${name}\\b[^;]*from`).test(code);       // imported
    if (!defined) {
      console.error(`${file.replace(SRC, "src/")}: <${name}> is used but not imported or defined`);
      problems++;
    }
  }
}

if (problems) {
  console.error(`\n✖ ${problems} undefined JSX component(s) — add the missing import(s).`);
  process.exit(1);
}
console.log("✓ JSX component imports OK");
