/**
 * An ESLint rule: the modules a browser entry point loads (index.ts, app.ts)
 * never load the transport index, which brings Playwright and sharp with it.
 * It reports the import in the linted file that reaches the index, so a change
 * that newly loads an old module from app.ts fails where it is made, and the
 * message names the module to fix. testing/publicSurface.test.ts checks the
 * packages the entry points load; this rule finds the import responsible.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Lint runs and editors reread the graph after this long, from the files that changed.
const GRAPH_MS = 2_000;
const parsed = new Map();
const graphs = new Map();

/** The specifiers a source file loads at run time, as testing/publicSurface.test.ts reads them. */
function runtimeSpecifiers(file) {
  const modified = statSync(file).mtimeMs;
  const cached = parsed.get(file);
  if (cached?.modified === modified) return cached.specifiers;
  const specifiers = [];
  const literal = (node) => { if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text); };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword) literal(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.isTypeOnly) literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest));
  parsed.set(file, { modified, specifiers });
  return specifiers;
}

/** The source module a relative specifier names, or null for a package or data. */
function resolve(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = path.join(path.dirname(from), specifier);
  return [target.replace(/\.js$/, '.ts'), target].find((candidate) => !candidate.endsWith('.json') && existsSync(candidate)) ?? null;
}

/** The modules the entry points load, and for each one that reaches the forbidden module, its next step there. */
function graph(root, entries, module) {
  const key = JSON.stringify([root, entries, module]);
  const cached = graphs.get(key);
  if (cached && Date.now() - cached.built < GRAPH_MS) return cached;
  const forbidden = path.join(root, module);
  const imports = new Map();
  const queue = entries.map((entry) => path.join(root, entry));
  while (queue.length) {
    const file = queue.pop();
    if (imports.has(file) || !existsSync(file)) continue;
    const targets = runtimeSpecifiers(file).map((specifier) => resolve(file, specifier)).filter(Boolean);
    imports.set(file, targets);
    if (file !== forbidden) queue.push(...targets);
  }
  const next = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, targets] of imports) {
      if (file === forbidden || next.has(file)) continue;
      const step = targets.find((target) => target === forbidden || next.has(target));
      if (step) { next.set(file, step); changed = true; }
    }
  }
  const built = { built: Date.now(), forbidden, imports, next };
  graphs.set(key, built);
  return built;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the transport index out of the modules a browser entry point loads' },
    schema: [{
      type: 'object',
      properties: {
        root: { type: 'string' },
        entries: { type: 'array', items: { type: 'string' } },
        module: { type: 'string' },
        instead: { type: 'string' },
      },
      required: ['root', 'entries', 'module', 'instead'],
      additionalProperties: false,
    }],
    messages: {
      reaches: 'A browser entry point ({{entries}}) loads this module, and this import loads {{module}}{{via}}. Import from {{instead}} there instead.',
    },
  },
  create(context) {
    const [{ root, entries, module, instead }] = context.options;
    const file = context.physicalFilename;
    const { forbidden, imports, next } = graph(root, entries, module);
    if (!imports.has(file) || file === forbidden) return {};
    const check = (node, source) => {
      if (typeof source?.value !== 'string') return;
      const target = resolve(file, source.value);
      if (target !== forbidden && !next.has(target)) return;
      const chain = [];
      for (let step = target; step !== forbidden; step = next.get(step)) chain.push(path.relative(root, step));
      context.report({ node, messageId: 'reaches', data: {
        entries: entries.join(', '), module, instead, via: chain.length ? ` through ${chain.join(' → ')}` : '',
      } });
    };
    return {
      ImportDeclaration: (node) => { if (node.importKind !== 'type') check(node, node.source); },
      ExportNamedDeclaration: (node) => { if (node.exportKind !== 'type') check(node, node.source); },
      ExportAllDeclaration: (node) => { if (node.exportKind !== 'type') check(node, node.source); },
      ImportExpression: (node) => check(node, node.source),
      TSImportEqualsDeclaration: (node) => {
        if (node.importKind !== 'type' && node.moduleReference.type === 'TSExternalModuleReference') check(node, node.moduleReference.expression);
      },
    };
  },
};
