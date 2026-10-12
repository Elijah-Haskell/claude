import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served from a sub-folder (GitHub Pages) or the root: VITE_BASE sets the public path at build time.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "/",
  server: { port: 5173 },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
