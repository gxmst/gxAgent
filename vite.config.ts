import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep Vite's dynamic-import runtime in the eagerly loaded vendor
          // chunk so lazy Markdown dependencies cannot pull each other into
          // the initial modulepreload graph.
          if (id.includes("vite/preload-helper")) return "vendor";
          if (!id.includes("node_modules")) return undefined;
          if (
            id.includes("/node_modules/mermaid/")
            || id.includes("/node_modules/@mermaid-js/")
            || id.includes("/node_modules/cytoscape")
            || id.includes("/node_modules/dagre")
          ) {
            return "diagram-vendor";
          }
          if (id.includes("react-syntax-highlighter") || id.includes("refractor") || id.includes("prismjs")) {
            return "syntax-vendor";
          }
          if (id.includes("katex")) return "math-vendor";
          if (id.includes("react-markdown") || id.includes("remark-") || id.includes("rehype-")) {
            return "markdown-vendor";
          }
          if (id.includes("react-virtuoso")) return "virtual-list-vendor";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
          return "vendor";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
