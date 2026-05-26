import { defineConfig } from 'vite';
import { proxyHandler } from './api/proxy.js';

export default defineConfig({
  plugins: [
    {
      name: 'api-proxy',
      configureServer(server) {
        server.middlewares.use('/api/proxy', proxyHandler);
      },
    },
  ],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
