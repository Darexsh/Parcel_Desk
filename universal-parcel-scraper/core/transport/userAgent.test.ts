import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_AGENT, userAgentOf } from './userAgent.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function sources(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'fixtures', 'dist'].includes(entry.name) ? [] : sources(relative);
    return /\.(?:ts|mjs)$/.test(entry.name) ? [relative] : [];
  });
}

describe('client User-Agent', () => {
  it('uses the host value when it is a usable header and the default otherwise', () => {
    expect(userAgentOf(undefined)).toBe(DEFAULT_USER_AGENT);
    expect(userAgentOf(null)).toBe(DEFAULT_USER_AGENT);
    expect(userAgentOf('  ExampleHost/2.1 (+https://example.test) ')).toBe('ExampleHost/2.1 (+https://example.test)');
    for (const invalid of ['', '   ', 'Example\r\nX-Injected: 1', 'Exämple/1.0', 'x'.repeat(257)]) {
      expect(() => userAgentOf(invalid)).toThrow(TypeError);
    }
  });

  it('is named in one module, so no adapter presents a client the host cannot change', () => {
    const product = /^Mozilla\/5\.0 \(compatible; (\w+)\/[\d.]+\)$/.exec(DEFAULT_USER_AGENT)![1]!;
    const named = (source: string) => source.includes(product) || /\(compatible; \w+\/[\d.]+\)/.test(source);
    const holders = ['carriers', 'providers', 'core', 'facade', 'server', 'cli', 'scripts', 'testing']
      .flatMap(sources).filter((file) => named(readFileSync(path.join(root, file), 'utf8')));
    expect(holders).toEqual(['core/transport/userAgent.ts']);
  });
});
