import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * Serves Excalidraw's fonts from the app itself under /excalidraw-assets/fonts (ExcalidrawPanel sets
 * EXCALIDRAW_ASSET_PATH), so drawings work offline and never load fonts from a CDN. Xiaolai (CJK,
 * ~13 MB) is left out; Chinese/Japanese/Korean text falls back to a system font.
 */
function excalidrawFonts(): Plugin {
  const fontsDir = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
  const PREFIX = '/excalidraw-assets/fonts/';
  const skip = (rel: string) => rel.startsWith('Xiaolai');
  const list = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  return {
    name: 'kladde-excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (!url.startsWith(PREFIX)) return next();
        const rel = decodeURIComponent(url.slice(PREFIX.length));
        const file = path.join(fontsDir, rel);
        if (skip(rel) || !file.startsWith(fontsDir + path.sep) || !fs.existsSync(file)) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('Content-Type', 'font/woff2');
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const file of list(fontsDir)) {
        const rel = path.relative(fontsDir, file).split(path.sep).join('/');
        if (!skip(rel)) this.emitFile({ type: 'asset', fileName: `excalidraw-assets/fonts/${rel}`, source: fs.readFileSync(file) });
      }
    },
  };
}

export default defineConfig({
  // Excalidraw's build reads this (see its Vite integration notes)
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  plugins: [
    react(),
    excalidrawFonts(),
    VitePWA({
      // lib/update.ts decides when the waiting new version takes over (not while the user types)
      registerType: 'prompt',
      // Registered in lib/update.ts, which also forces updates
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/icon.svg', 'robots.txt'],
      manifest: {
        name: 'Kladde',
        short_name: 'Kladde',
        description: 'Notizen, Aufgaben und Wissen – offline und auf allen Geräten',
        lang: 'de',
        start_url: '/',
        display: 'standalone',
        background_color: '#121318',
        theme_color: '#121318',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/health/, /^\/mcp/, /^\/\.well-known\//, /^\/oauth\/(token|register|revoke)/],
        runtimeCaching: [
          {
            // Attachments are immutable: once seen they work offline
            urlPattern: ({ url }) => url.pathname.startsWith('/api/files/'),
            handler: 'CacheFirst',
            options: { cacheName: 'kladde-files', expiration: { maxEntries: 500 } },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:3002' },
      '/health': { target: 'http://localhost:3002' },
      // MCP and its OAuth endpoints; /oauth/authorize is the consent page of the app itself
      '/mcp': { target: 'http://localhost:3002' },
      '/.well-known/oauth-': { target: 'http://localhost:3002' },
      '^/oauth/(token|register|revoke)': { target: 'http://localhost:3002' },
    },
  },
});
