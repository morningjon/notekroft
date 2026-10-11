import { defineConfig } from 'vite';
import { version } from './package.json';

// The UI lives in ui/. Tauri expects a fixed dev port and its own console.
export default defineConfig({
  root: 'ui',
  // Shown in Help, About.
  define: { __APP_VERSION__: JSON.stringify(version) },
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/target/**'] } },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
