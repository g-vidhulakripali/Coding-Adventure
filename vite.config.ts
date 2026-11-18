import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `base: './'` produces relative asset URLs so the build works from any static
// host sub-path (GitHub Pages, Netlify, Cloudflare Pages) without a server.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
