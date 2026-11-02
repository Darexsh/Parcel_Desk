/**
 * The published surface, pinned. Adding, moving or removing an export, a value
 * or a type, changes publicSurface.json in the same commit, so it is a
 * decision rather than a side effect of `export *`. The entry points a browser
 * loads reach no Node module, no package outside the browser's list and no
 * global that only Node has.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as app from '../app.js';
import * as browser from '../index.js';
import * as node from '../node.js';
import * as places from '../places/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const pinned = JSON.parse(read('testing/publicSurface.json')) as Record<string, { values: string[]; types: string[] }>;
const entries: Record<string, { file: string; namespace: object }> = {
  '.': { file: 'index.ts', namespace: browser },
  './node': { file: 'node.ts', namespace: node },
  './app': { file: 'app.ts', namespace: app },
  './places': { file: 'places/index.ts', namespace: places },
};
/** Every package index.ts and app.ts may load; each one runs in a browser. */
const BROWSER_PACKAGES = ['luxon'];

// The entry points as the project's own compiler options resolve them.
const { options } = ts.convertCompilerOptionsFromJson(ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config.compilerOptions, root);
const program = ts.createProgram(Object.values(entries).map(({ file }) => path.join(root, file)), options);
const checker = program.getTypeChecker();
const parsed = (file: string) => program.getSourceFile(path.join(root, file))!;

/** The exports only TypeScript sees: interfaces, aliases and `export type` names, which no namespace object holds. */
function typeExports(entry: string): string[] {
  const { file, namespace } = entries[entry]!;
  return checker.getExportsOfModule(checker.getSymbolAtLocation(parsed(file))!)
    .map((symbol) => symbol.name).filter((name) => !(name in namespace)).sort();
}

/** The specifiers a source file loads at run time; type-only declarations are erased and not listed. */
function runtimeSpecifiers(file: string, source: string): string[] {
  const specifiers: string[] = [];
  const literal = (specifier: ts.Node | undefined, what: string) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) throw new Error(`${file}: ${what} of a computed specifier`);
    specifiers.push(specifier.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) literal(node.moduleSpecifier, 'import');
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly) literal(node.moduleSpecifier, 'export');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.isTypeOnly) literal(node.moduleReference.expression, 'require()');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      literal(node.arguments[0], 'import()');
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest));
  return specifiers;
}

/** Every module an entry loads at run time and every package those modules name. */
function runtimeImports(entry: string, source: (file: string) => string = read): { modules: string[]; packages: string[] } {
  const modules = new Set<string>(), packages = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const specifier of runtimeSpecifiers(file, source(file))) {
      if (!specifier.startsWith('.')) { packages.add(specifier); continue; }
      const target = path.join(path.dirname(file), specifier);
      const resolved = [target.replace(/\.js$/, '.ts'), target].find((candidate) => existsSync(path.join(root, candidate)));
      if (!resolved) throw new Error(`${file}: ${specifier} does not resolve`);
      if (!resolved.endsWith('.json')) queue.push(resolved);
    }
  }
  return { modules: [...modules], packages: [...packages] };
}

const outsideBrowser = (packages: string[]) => packages.filter((name) => !BROWSER_PACKAGES.includes(name));

/** Whether Node's types alone declare a symbol: `process` and `Buffer`, not the `URL` or `fetch` a browser shares. */
function nodeOnly(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations ?? [];
  return declarations.length > 0 && declarations.every((declaration) => declaration.getSourceFile().fileName.includes('/node_modules/@types/node/'));
}

/**
 * The Node-only globals and members a module's code names. Its types are erased
 * and not read, and neither are its import and export declarations: the
 * package list answers for what those load.
 */
function nodeGlobals(file: string, from = program): string[] {
  const types = from.getTypeChecker(), found: string[] = [];
  const visit = (node: ts.Node): void => {
    // isPartOfTypeNode rather than isTypeNode: a superclass and an instantiation expression are code the syntax tree files with types.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isPartOfTypeNode(node)) return;
    if (ts.isIdentifier(node)) {
      // A shorthand property reads the variable of its name; the identifier's own symbol is the property.
      const symbol = ts.isShorthandPropertyAssignment(node.parent) ? types.getShorthandAssignmentValueSymbol(node.parent) : types.getSymbolAtLocation(node);
      if (nodeOnly(symbol)) found.push(`${file}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(from.getSourceFile(path.join(root, file))!);
  return found;
}

/** A program of one module read from a string, under the same options and over the files already parsed. */
function withModule(file: string, source: string): ts.Program {
  const host = ts.createCompilerHost(options);
  const fromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, ...rest) => name === path.join(root, file)
    ? ts.createSourceFile(name, source, languageVersion)
    : program.getSourceFile(name) ?? fromDisk(name, languageVersion, ...rest);
  return ts.createProgram([path.join(root, file)], options, host);
}

describe('published surface', () => {
  it.each(Object.keys(entries))('%s exports exactly the values that are pinned', (entry) => {
    expect(Object.keys(entries[entry]!.namespace).sort()).toEqual(pinned[entry]!.values);
  });

  it.each(Object.keys(entries))('%s exports exactly the types that are pinned', (entry) => {
    expect(typeExports(entry)).toEqual(pinned[entry]!.types);
  });

  it('pins every entry point the package declares', () => {
    const declared = Object.keys((JSON.parse(read('package.json')) as { exports: Record<string, unknown> }).exports);
    expect(declared.sort()).toEqual([...Object.keys(pinned), './data/*'].sort());
  });

  it('keeps the app helpers out of the tracking contract', () => {
    const names = (entry: string) => [...pinned[entry]!.values, ...pinned[entry]!.types];
    expect(names('.').filter((name) => names('./app').includes(name))).toEqual([]);
  });

  it('lists in the published carrier schema the inputs a requirement can name', () => {
    const { field } = JSON.parse(read('data/carrier.schema.json')).definitions.requirement.properties;
    expect(new Set(field.enum)).toEqual(new Set(Object.keys(browser.normalizeCarrierInputs('unknown', '', '', ''))));
  });

  it.each(['index.ts', 'app.ts'])('%s loads only what a browser runs', (entry) => {
    const { modules, packages } = runtimeImports(entry);
    expect(modules.length).toBeGreaterThan(10);
    expect(outsideBrowser(packages)).toEqual([]);
    expect(modules.flatMap((file) => nodeGlobals(file))).toEqual([]);
  });
});

describe('browser check', () => {
  it.each([
    ['an import list whose trailing comment holds a quote', "import {\n  readFileSync, // the caller's file; sync\n} from 'node:fs';", 'node:fs'],
    ['a re-export after a string that holds a comment opener', "const accept = '*/*';\nexport * from './sub.js';\nconst end = '*/';", './sub.js'],
    ['an import after a regular expression that holds a comment opener', "const trailing = /\\/*$/;\nimport 'node:fs'; /* */", 'node:fs'],
    ['import() of a template literal', 'await import(`node:fs`);', 'node:fs'],
    ['import() with attributes', "await import('./data.json', { with: { type: 'json' } });", './data.json'],
    ['import = require()', "import fs = require('node:fs');", 'node:fs'],
    ['an import with an inline type specifier', "import { type PathLike } from 'node:fs';", 'node:fs'],
  ])('reads the specifier of %s', (_, source, specifier) => {
    expect(runtimeSpecifiers('entry.ts', source)).toEqual([specifier]);
  });

  it('skips the declarations that are type-only', () => {
    const source = "import type { Stats } from 'node:fs';\nexport type { Dirent } from 'node:fs';\nimport type fs = require('node:fs');";
    expect(runtimeSpecifiers('entry.ts', source)).toEqual([]);
  });

  it('refuses an import() whose specifier is computed', () => {
    expect(() => runtimeSpecifiers('entry.ts', 'await import(name);')).toThrow('entry.ts: import() of a computed specifier');
  });

  it('refuses a relative specifier that does not resolve', () => {
    expect(() => runtimeImports('index.ts', () => "export * from './absent.js';")).toThrow('index.ts: ./absent.js does not resolve');
  });

  it('counts every package off the browser list, Node builtin or not', () => {
    const { packages } = runtimeImports('index.ts', () => "import 'luxon';\nimport 'playwright-core';\nimport 'node:fs';\nimport 'fs/promises';");
    expect(outsideBrowser(packages)).toEqual(['playwright-core', 'node:fs', 'fs/promises']);
  });

  it('tells the globals only Node has from the ones a browser shares', () => {
    const names = ['process', 'Buffer', 'require', 'URL', 'fetch', 'setTimeout', 'AbortSignal'];
    expect(names.filter((name) => nodeOnly(checker.resolveName(name, undefined, ts.SymbolFlags.Value, false)))).toEqual(['process', 'Buffer', 'require']);
  });

  it.each([
    ['a global and its member', 'export const environment = process.env;', ['process', 'env']],
    ['a member Node adds to a shared global', 'export const here = import.meta.dirname;', ['dirname']],
    ['a superclass', 'export class Bytes extends Buffer {}', ['Buffer']],
    ['a shorthand property', 'export const globals = { setImmediate };', ['setImmediate']],
    ['an instantiation expression', 'export const later = setImmediate<[]>;', ['setImmediate']],
  ])('finds the Node-only names of %s', (_, source, names) => {
    expect(nodeGlobals('entry.ts', withModule('entry.ts', source))).toEqual(names.map((name) => `entry.ts: ${name}`));
  });

  it.each([
    ['a type-only import under another name', "import type { Stats as FileStats } from 'node:fs';\nexport type Size = FileStats['size'];"],
    ['a type-only re-export under another name', "export type { Stats as FileStats } from 'node:fs';"],
    ['the parent of an interface', 'export interface Emitter extends NodeJS.EventEmitter {}'],
    ['a type argument of a superclass', 'export class Chunks extends Array<Buffer> {}'],
    ['an annotation, an assertion and a type query', 'export const bytes = (value: unknown): Buffer => value as Buffer;\nexport type Process = typeof process;'],
  ])('reads no Node-only name from %s', (_, source) => {
    expect(nodeGlobals('entry.ts', withModule('entry.ts', source))).toEqual([]);
  });
});
