import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  build: {
    // AI-Character Vite 8 chunking
        rolldownOptions: {
          input: {
            index: "index.html",
            "work-log": "work-log.html",
          },
          output: {
            strictExecutionOrder: true,
            codeSplitting: {
              groups: [
                {
                  name: "vendor",
                  test: /node_modules/,
                  maxSize: 280000,
                  priority: 10,
                },
              ],
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
      ignored: [
        "**/src-tauri/**",
        "**/.git/**",
        "**/.ai-character/**",
        "**/.ai-character-logs/**",
        "**/dist/**",
      ],
    },
  },
}));
