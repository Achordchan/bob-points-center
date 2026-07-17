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
    // 不再把 antd / wangeditor 打成超大 manualChunks；交给 Rollup 按页面动态导入自然拆包。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'react-vendor';
          }
        },
      },
    },
    chunkSizeWarningLimit: 900,
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
