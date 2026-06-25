import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin-app/',
  plugins: [react()],
  build: {
    outDir: '../pages/admin-app-dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      '/admin': 'http://127.0.0.1:3000',
      '/bob-token': 'http://127.0.0.1:3000',
      '/docs': 'http://127.0.0.1:3000',
    },
  },
});
