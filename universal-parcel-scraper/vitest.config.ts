import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['**/*.test.ts'], exclude: ['**/*.live.test.ts', '**/node_modules/**', '**/dist/**'], environment: 'node', maxWorkers: 4, testTimeout: 30_000 } });
