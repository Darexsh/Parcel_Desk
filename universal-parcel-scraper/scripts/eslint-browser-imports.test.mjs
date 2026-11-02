import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './eslint-browser-imports.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = mkdtempSync(path.join(tmpdir(), 'browser-imports-'));
after(() => rmSync(root, { recursive: true, force: true }));
const files = {
  'app.ts': "import './text-user.js';\nexport * from './status.js';\nimport './types.js';",
  'text-user.ts': "import { clean } from './core/transport/text.js';",
  'status.ts': "export { clean } from './parser.js';",
  'parser.ts': "import { clean } from './core/transport/index.js';",
  'types.ts': "import type { Client } from './core/transport/index.js';",
  'adapter.ts': "import { clean } from './core/transport/index.js';",
  'core/transport/index.ts': "export * from './text.js';",
  'core/transport/text.ts': 'export const clean = (value) => value;',
};
for (const [name, source] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  writeFileSync(path.join(root, name), source);
}

const options = [{ root, entries: ['app.ts'], module: 'core/transport/index.ts', instead: 'core/transport/text.js' }];
const at = (name, code = files[name]) => ({ filename: path.join(root, name), code, options });
const reaches = (via) => ({ messageId: 'reaches', data: { entries: 'app.ts', module: 'core/transport/index.ts', instead: 'core/transport/text.js', via } });

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run('browser-imports', rule, {
  valid: [
    // The text module alone, a type-only import, and a module no entry point loads.
    at('text-user.ts'),
    at('types.ts'),
    at('adapter.ts'),
  ],
  invalid: [
    { ...at('parser.ts'), errors: [reaches('')] },
    { ...at('status.ts'), errors: [reaches(' through parser.ts')] },
    { ...at('app.ts'), errors: [reaches(' through status.ts → parser.ts')] },
    // The linted text, not the saved file: a new import fails before it is written.
    { ...at('text-user.ts', "await import('./parser.js');"), errors: [reaches(' through parser.ts')] },
  ],
});
