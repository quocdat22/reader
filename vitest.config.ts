import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    svelte({
      dynamicCompileOptions: () => ({ generate: "client" }),
    }),
  ],
  resolve: {
    conditions: ["browser"],
  },
  ssr: {
    resolve: {
      conditions: ["browser"],
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
  },
});
