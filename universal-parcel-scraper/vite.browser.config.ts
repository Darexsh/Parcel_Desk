import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: 'dist/browser', emptyOutDir: false,
  lib: { entry: 'index.ts', formats: ['es'], fileName: () => 'scraper.js' } } });
