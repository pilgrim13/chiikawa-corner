import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  base: './', plugins: [react(), {
    name: 'production-csp', apply: 'build',
    transformIndexHtml() { return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; font-src 'self' data:; object-src 'none'; base-uri 'self'" }, injectTo: 'head' }]; }
  }],
  server: { port: 5179, strictPort: true, proxy: { '/socket.io': { target: 'http://127.0.0.1:47831', ws: true }, '/health': 'http://127.0.0.1:47831' } },
  build: { outDir: 'dist', sourcemap: false }
});
