import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useHttps = env.VITE_DEV_HTTPS === 'true';
  const apiTarget = `http://localhost:${env.PORT || 8787}`;
  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    define: {
      __STATIC_HOST__: JSON.stringify(process.env.VERCEL === '1' || env.VITE_STATIC_HOST === 'true'),
    },
    server: { host: true, port: 5173, proxy: { '/api': apiTarget, '/uploads': apiTarget } },
    preview: { host: true, proxy: { '/api': apiTarget, '/uploads': apiTarget } },
    build: { chunkSizeWarningLimit: 4000 },
  };
});
