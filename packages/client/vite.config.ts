import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
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
        background_color: '#14141B',
        theme_color: '#14141B',
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
