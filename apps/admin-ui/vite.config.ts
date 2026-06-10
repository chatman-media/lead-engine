import { fileURLToPath, URL } from "node:url";
import { codecovVitePlugin } from "@codecov/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // Codecov Bundle Analysis — uploads bundle stats when CODECOV_TOKEN is set
    // (CI only); no-op locally. Must come after all other plugins.
    codecovVitePlugin({
      enableBundleAnalysis: process.env.CODECOV_TOKEN !== undefined,
      bundleName: "admin-ui",
      uploadToken: process.env.CODECOV_TOKEN,
      gitService: "github",
    }),
  ],
  // ADMIN_UI_BASE=/ — для раздачи с собственного поддомена (client.exchanges.agency);
  // без env сохраняется прежний путь /admin/ на основном домене.
  base: command === "build" ? (process.env.ADMIN_UI_BASE ?? "/admin/") : "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
}));
