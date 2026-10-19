import { defineConfig } from "vite";

const api = `http://127.0.0.1:${process.env.TESTBENCH_API_PORT ?? 4100}`;
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": api, "/uploads": api, "/trace-viewer": api },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
