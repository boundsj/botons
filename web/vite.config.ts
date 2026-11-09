import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { webAllowedHosts } from '../scripts/dev-env.ts';
import { earlierStorageKey } from '../shared/legacy-names.mjs';

// Dev only: proxy to the dev API server on 7778, never the live one on 7777.
const api = process.env.BOTONS_API || 'http://127.0.0.1:7778';

export default defineConfig({
  plugins: [
    react(),
    // The theme's earlier storage key, for index.html's first paint (shared/legacy-names.mjs).
    { name: 'earlier-theme-key', transformIndexHtml: (html) => html.replace('__EARLIER_THEME_KEY__', earlierStorageKey('botons.theme') ?? '') },
  ],
  build: {
    rolldownOptions: {
      output: {
        // Each chunk stays under Vite's 500 kB warning.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 2 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    host: process.env.BOTONS_WEB_HOST || '127.0.0.1',
    port: Number(process.env.BOTONS_WEB_PORT || 5173),
    // Vite refuses other host names before proxying, so the API server's allowed hosts must be listed here too.
    allowedHosts: webAllowedHosts(process.env),
    // Keep the browser's Host header so the server's same-origin check sees Origin and Host agree.
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/hooks': { target: api, changeOrigin: false },
    },
  },
});
