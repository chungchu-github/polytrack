import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/health": "http://localhost:3000",
      "/socket.io": {
        target: "http://localhost:3000",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split large/rarely-changing deps into their own chunks so the main
        // bundle shrinks and browsers can cache vendor code across deploys.
        manualChunks: {
          recharts: ["recharts"],
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          socket: ["socket.io-client"],
        },
      },
    },
  },
});
