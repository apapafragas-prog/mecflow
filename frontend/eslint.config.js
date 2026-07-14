// Minimal ESLint config — a targeted safety net, NOT full linting.
// We only enforce `no-undef` to catch the class of bug that the Vite build does NOT flag:
// an identifier used but never defined/imported (e.g. a missing calc.js import → blank screen).
// Stylistic/unused rules are intentionally left off to avoid noise on the App.jsx monolith.
import globals from "globals";

export default [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.{js,jsx}"],
    // Keep the legacy `eslint-disable-next-line` hints (for react-hooks/exhaustive-deps) quiet —
    // that rule isn't enabled here, so they'd otherwise warn as "unused directive".
    linterOptions: { reportUnusedDisableDirectives: "off" },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    rules: {
      "no-undef": "error",
    },
  },
];
