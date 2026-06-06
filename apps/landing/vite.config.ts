import { codecovVitePlugin } from "@codecov/vite-plugin";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    // Codecov Bundle Analysis — uploads when CODECOV_TOKEN is set (CI only).
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: "landing",
      uploadToken: process.env.CODECOV_TOKEN,
      gitService: "github",
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    historyApiFallback: true,
  },
  preview: {
    historyApiFallback: true,
  },
});
