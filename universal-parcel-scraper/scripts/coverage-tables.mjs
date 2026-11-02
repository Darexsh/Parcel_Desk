/*
 * Regenerates the tables of providers/COVERAGE.md from
 * providers/coverage.json: the results per carrier and source, and the lookup
 * order routing derives from them.
 *
 * The order comes from the TypeScript routing code, which plain node cannot
 * import (extensionless imports), so this script drives the coverage test in
 * update mode.
 *
 *   node scripts/coverage-tables.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.config.ts', 'providers/coverage.test.ts'],
  { cwd: repositoryRoot, stdio: 'inherit', env: { ...process.env, ...(process.argv.includes('--check') ? {} : { UPDATE_COVERAGE_TABLES: '1' }) } },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
