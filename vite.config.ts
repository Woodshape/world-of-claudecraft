import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const SPRITES_ROOT = fileURLToPath(new URL('sprites', import.meta.url));

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

/** Serve repo-root /sprites in dev and copy into dist/ on production build. */
function spritesStaticPlugin(): Plugin {
  return {
    name: 'sprites-static',
    configureServer(server) {
      server.middlewares.use('/sprites', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        const file = join(SPRITES_ROOT, rel);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(SPRITES_ROOT)) return;
      cpSync(SPRITES_ROOT, join(process.cwd(), 'dist', 'sprites'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [spritesStaticPlugin()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/admin/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        admin: fileURLToPath(new URL('admin.html', import.meta.url)),
      },
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
