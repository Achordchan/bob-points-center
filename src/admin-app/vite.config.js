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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@wangeditor')) return 'wangeditor';
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) return 'antd';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendor';
        },
      },
    },
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
