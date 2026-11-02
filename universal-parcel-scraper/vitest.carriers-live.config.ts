import { defineConfig } from 'vitest/config';
// Files run one after another. Isolating each one re-imported the shared modules for every file,
// most of which skip without live inputs, and that alone outgrew the canary's time limit.
export default defineConfig({ test: { include: ['carriers/**/*.live.test.ts', 'providers/**/*.live.test.ts', 'testing/**/*.live.test.ts'], environment: 'node', fileParallelism: false, isolate: false, maxConcurrency: 1, testTimeout: 60_000, reporters: ['default', './scripts/canary-report.mjs'] } });
