import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const host = process.env.TAURI_DEV_HOST;
const here = dirname(fileURLToPath(import.meta.url));

/** Copy pdf.js static assets (cmaps for CJK fonts, standard fonts, wasm decoders) into public/pdfjs. */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    configResolved() {
      const require = createRequire(import.meta.url);
      const pkgDir = dirname(require.resolve('pdfjs-dist/package.json'));
      const dest = join(here, 'public', 'pdfjs');
      for (const sub of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        const from = join(pkgDir, sub);
        const to = join(dest, sub);
        if (existsSync(from) && !existsSync(to)) {
          mkdirSync(dest, { recursive: true });
          cpSync(from, to, { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsAssets()],
  resolve: { alias: { '@': join(here, 'src') } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: { target: 'es2022' },
});
