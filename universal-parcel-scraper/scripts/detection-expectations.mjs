/*
 * Refreshes the corpus after a deliberate detection rule change: records whose
 * answer only gained the named carriers as candidates, the collision
 * declarations their overlaps grew from, and their gaps no record needs any
 * more. What the named carriers do not explain is listed and left as it is.
 *
 * Run it after npm run generate, since detection reads the generated catalog,
 * and rewrite the golden file once the diff shows only the changes you meant.
 * The engine is TypeScript, so this script drives the refresh test in update
 * mode, as detection-golden.mjs does. The writing happens in
 * core/testing/expectations.ts.
 *
 *   npm run generate:expectations -- <carrier-id> [<carrier-id> ...]
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const carriers = process.argv.slice(2);

if (carriers.length === 0) {
  console.error('Usage: npm run generate:expectations -- <carrier-id> [<carrier-id> ...]');
  process.exit(1);
}

const result = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--config',
    'vitest.config.ts',
    'core/testing/expectations.test.ts',
    // Shows the count of records rewritten.
    '--silent=false',
  ],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, UPDATE_DETECTION_EXPECTATIONS: carriers.join(',') },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.status === 0) console.log('Review the diff, then run npm run generate:golden.');
process.exit(result.status ?? 1);
