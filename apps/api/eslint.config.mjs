import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default defineConfig([
  globalIgnores(["node_modules/**", "drizzle/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Must stay last: switches off rules that fight Prettier.
  prettier,
]);
