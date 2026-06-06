import { codecovVitePlugin } from "@codecov/vite-plugin";
import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Build output: single self-contained IIFE script с inline CSS. Customer
 * сайт включает через `<script async src="<publicUrl>/widget.js" data-slug=...>`,
 * скрипт сам читает свои data-attrs + mount'ит UI.
 *
 * Target: <50KB gzip (vanilla TS, no React/framework dep).
 * Build artifact: dist/widget.js (single file).
 */
export default defineConfig({
  plugins: [
    // Codecov Bundle Analysis — uploads when CODECOV_TOKEN is set (CI only).
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: "widget",
      uploadToken: process.env.CODECOV_TOKEN,
      gitService: "github",
    }),
  ],
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["iife"],
      name: "LeadEngineWidget",
      fileName: () => "widget.js",
    },
    rollupOptions: {
      output: {
        // Inline everything — single file.
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
  },
  server: {
    port: 5174,
    open: "/demo/index.html",
  },
});
