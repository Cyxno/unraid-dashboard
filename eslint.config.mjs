import { defineConfig, globalIgnores } from "eslint/config";
import unusedImports from "eslint-plugin-unused-imports";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      // Fase 14 (v1.3.17): unused imports get a SAFE autofix; other unused
      // bindings stay visible warnings and are fixed by hand. Underscore-
      // prefixed bindings are the documented "intentionally unused" marker.
      "unused-imports/no-unused-imports": "error",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
      }],
    },
  },
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
    // Generated release-gate fixture (models the v1.3.13 missing-import
    // incident; requires CommonJS by design — covered by the runtime smoke).
    "tests/fixtures/helper-broken/**",
    // Session-local QA scratch dir (untracked; never lint-worthy).
    "tmp-qa/**",
    // Generated release artifacts and build output.
    "src/generated/**","public/sw.js",
  ]),
]);

export default eslintConfig;
