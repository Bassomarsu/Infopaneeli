import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // During frontend development the API still comes from the real backend.
    proxy: {
      "/api": "http://localhost:4173",
    },
  },
});
