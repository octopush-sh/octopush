import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  build: {
    // Vite 8 bundles with Rolldown. The only build entry is index.html (the
    // app); clips.html is a dev-only demo harness served by the dev server and
    // is intentionally NOT listed as an input, so it never ships in dist/.
    rolldownOptions: {
      output: {
        // Rolldown has no object-form `manualChunks`; `codeSplitting.groups`
        // is its replacement. Same three vendor chunks as before.
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "vendor-xterm",
              test: /[\\/]node_modules[\\/]@xterm[\\/](xterm|addon-fit|addon-web-links)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor-charts",
              test: /[\\/]node_modules[\\/]recharts[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },

  // Vitest configuration
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // scripts/**/*.test.mjs are `node --test` suites (CI runs them in repo-rules);
    // Vitest can't load node:test, so keep its scope to the app.
    include: ["src/**/*.test.{ts,tsx}"],
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
