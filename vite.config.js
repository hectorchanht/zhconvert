import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  // The conversion Worker is a module worker ({ type: 'module' }) and its
  // dependency graph code-splits (lazy zh-convert dictionaries) — the
  // default 'iife' worker format cannot do that, 'es' can.
  worker: { format: 'es' }
});
