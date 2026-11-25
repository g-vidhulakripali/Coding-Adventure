import { createHash } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * A strict content policy for the built app: code only from this site, no
 * connections to anywhere else, nothing embedded. Even a mistake in the app could
 * not send an imported project away. (The dev server needs more freedom.)
 */
function contentPolicy(): Plugin {
  return {
    name: 'content-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
        const policy = [
          "default-src 'none'",
          // WebAssembly is needed for Tree-sitter; no other code generation is allowed.
          `script-src 'self' 'wasm-unsafe-eval' ${inline.join(' ')}`,
          // The code viewer adds its style sheet at runtime.
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' blob: data:",
          "font-src 'self'",
          "connect-src 'self'",
          "worker-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
        return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <meta name="referrer" content="no-referrer" />`);
      },
    },
  };
}

// `base: './'` produces relative asset URLs so the build works from any static
// host sub-path (GitHub Pages, Netlify, Cloudflare Pages) without a server.
export default defineConfig({
  base: './',
  plugins: [react(), contentPolicy()],
  build: {
    target: 'es2022',
    sourcemap: true,
    // The 3D laboratory chunk (Three.js, ~150 KB gzipped) is lazy-loaded only when the 3D view opens.
    chunkSizeWarningLimit: 650,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
