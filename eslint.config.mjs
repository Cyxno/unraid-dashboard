import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The update helper is a standalone CommonJS container script — it is
    // intentionally outside the Next.js/TS toolchain and has its own checks.
    "helper/**",
    // Browser/soak validation harnesses run via plain node.
    "validate-browser.mjs",
    "soak-noc.mjs",
  ]),
]);

export default eslintConfig;
