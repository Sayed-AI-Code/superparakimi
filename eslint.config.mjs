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
    // Flat config does not read .gitignore, so listing it here is the only
    // thing that keeps a linked git worktree — and the bundled build output
    // inside it — from being linted as this project's source.
    ".worktrees/**",
  ]),
]);

export default eslintConfig;
