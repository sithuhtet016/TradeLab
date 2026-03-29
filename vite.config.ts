import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Dev server uses a WebSocket for Hot Module Replacement (HMR). If DevTools shows
 * "WebSocket connection failed", that is usually Vite’s HMR — not Supabase.
 *
 * Tips:
 * - Open the app at the same URL Vite prints (often http://localhost:5173).
 * - Do not mix localhost and 127.0.0.1 — pick one and stick to it.
 * - Try disabling ad-blockers / privacy extensions for localhost.
 * - The page can still work; only live reload may break.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
