import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['scripts/coverage-probe.run.ts'], environment: 'node', fileParallelism: false, testTimeout: 600_000 } });
