import { describe, expect, it } from 'vitest';
import { workerExecArgv } from './ocrWorker.js';

describe('OCR worker', () => {
  it('passes the host\'s Node flags on, but not the module input type a worker refuses', () => {
    expect(workerExecArgv(['--input-type=module', '--max-old-space-size=512'])).toEqual(['--max-old-space-size=512']);
    expect(workerExecArgv(['--input-type', 'module', '--no-warnings'])).toEqual(['--no-warnings']);
    expect(workerExecArgv([])).toEqual([]);
  });
});
