import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useHttps = env.VITE_DEV_HTTPS === 'true';
  const apiTarget = `http://localhost:${env.PORT || 8787}`;

  return {
    plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget,
      },
    },
    preview: {
      host: true,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget,
      },
    },
    build: {
      // MindAR bundles TensorFlow.js, which is large but only loaded lazily
      // on the AR page and the target compiler.
      chunkSizeWarningLimit: 4000,
    },
  };
});
