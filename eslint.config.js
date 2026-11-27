import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import tseslint from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

export default defineConfig(
  {
    ignores: ["dist/", "coverage/", "src-tauri/", ".agents/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  eslintConfigPrettier,
  ...svelte.configs.prettier,
  {
    files: ["src/**/*.{ts,svelte}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    files: ["*.config.{js,ts}", "svelte.config.js", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: tseslint.parser,
        svelteConfig,
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
