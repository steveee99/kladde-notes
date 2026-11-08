import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
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
    },
  },
});
