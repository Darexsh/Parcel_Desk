import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveZtoCharacters } from './zto-ocr.mjs';

// Without the image's Python environment every worker fails to start, which frees its slot at once.
test('a third request waits for a worker instead of giving up, and labels each failure', async () => {
  const signal = new AbortController().signal;
  const answers = await Promise.all([1, 2, 3].map(() => solveZtoCharacters({}, signal, 5000)));
  assert.deepEqual(answers.map(answer => answer.failure), ['spawn', 'spawn', 'spawn']);
  assert.equal(answers.every(answer => Number.isInteger(answer.ms) && Number.isInteger(answer.waitMs)), true);
  assert.equal((await solveZtoCharacters({}, AbortSignal.abort(), 5000)).failure, 'budget');
  assert.equal((await solveZtoCharacters({}, signal, 500)).failure, 'budget');
});
