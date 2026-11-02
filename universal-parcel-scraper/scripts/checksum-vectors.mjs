/*
 * Regenerates data/checksum-vectors.json: synthetic inputs for every checksum
 * a detection rule can name, with the answer its validator gives. The native
 * tests replay this file, so the answers have to come from the validators
 * themselves rather than from a second implementation here.
 *
 * The validators are TypeScript with extensionless imports, which plain node
 * cannot resolve, so this script drives the vectors test in update mode. The
 * writing happens in core/testing/checksumVectors.ts.
 *
 *   node scripts/checksum-vectors.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const result = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--config',
    'vitest.config.ts',
    'core/testing/checksumVectors',
  ],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, UPDATE_CHECKSUM_VECTORS: '1' },
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
