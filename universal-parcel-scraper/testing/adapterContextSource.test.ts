/**
 * Every transport call and every timer in a carrier or provider module is
 * written with the signal of its lookup: `fetchBounded` in its init, the
 * browser service, the local browser and the promise timer in their options,
 * and a timer set by hand in a function that listens for the abort.
 * `adapterContext.test.ts` drives each lookup against a transport that never
 * answers, which holds it at its first request; this scan reads the sources,
 * so the requests, browser calls and pauses after the first are held to the
 * same rule. It reads that a signal is written, not which one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The transport calls and the promise timer, by the module that declares them, and the argument that takes the signal. */
const TRANSPORTS: Readonly<Record<string, { module: string; argument: number }>> = {
  fetchBounded: { module: 'core/transport/boundedFetch.ts', argument: 1 },
  scrape: { module: 'core/transport/trawl.ts', argument: 1 },
  solve: { module: 'core/transport/trawl.ts', argument: 1 },
  scrapeUniversalPage: { module: 'core/transport/browser.ts', argument: 0 },
  withLocalBrowser: { module: 'core/transport/localBrowser.ts', argument: 0 },
  setTimeout: { module: 'node_modules/@types/node/timers/promises.d.ts', argument: 2 },
};
/** The global `setTimeout`, which takes no signal: the function it is set in has to listen for the abort. */
const TIMER = { name: 'setTimeout by hand', module: 'node_modules/@types/node/web-globals/timers.d.ts' };

/** Calls that have no lookup's signal to take, by file and enclosing function. */
const WITHOUT_SIGNAL: Readonly<Record<string, string>> = {
  'carriers/asendia/probe.ts requestText': 'A protocol probe outside the registry: its lookup is given no TrackingContext.',
  'carriers/asendia/probe.ts requestJson': 'The same probe.',
  'carriers/swiss-post/adapter.ts readJson': 'Sets the signal of the budget it is handed, and every request of a lookup hands its own; '
    + 'only `loadTranslations` called outside a lookup comes without one.',
  'carriers/mondial-relay/app.ts #renew': 'One token renewal serves every lookup waiting for it; each stops waiting on its own signal, '
    + 'and the request keeps its timeout.',
  'carriers/dpd-de/service.ts #retry': 'Opens again the DPD app session a long-lived host keeps open after a failed opening: no '
    + 'lookup waits on the timer, which does not keep the process alive.',
  'carriers/dpd-de/service.ts #load': 'Bounds the wait for a long-lived host\'s session store at start; a lookup waits for the '
    + 'load on its own signal.',
  'carriers/dpd-de/service.ts #follow': 'Checks the DPD app sessions of a long-lived host every hour: no lookup waits on the '
    + 'timer, which does not keep the process alive.',
  'carriers/dpd-de/service.ts #check': 'Spaces those checks apart: no lookup waits on them.',
};

const { config } = ts.readConfigFile(path.join(root, 'tsconfig.json'), (file) => ts.sys.readFile(file));
const program = ts.createProgram(
  ts.sys.readDirectory(root, ['.ts'], ['**/*.test.ts'], ['carriers', 'providers']),
  ts.convertCompilerOptionsFromJson(config.compilerOptions, root).options,
);
const checker = program.getTypeChecker();

/** The transport or timer a call resolves to, through import aliases and re-exports, or null. */
function transportOf(call: ts.CallExpression): string | null {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || !Object.hasOwn(TRANSPORTS, symbol.name)) return null;
  const modules = (symbol.declarations ?? []).map((declaration) => path.relative(root, declaration.getSourceFile().fileName));
  if (modules.includes(TRANSPORTS[symbol.name]!.module)) return symbol.name;
  return symbol.name === 'setTimeout' && modules.includes(TIMER.module) ? TIMER.name : null;
}

const named = (property: ts.ObjectLiteralElementLike, name: string) =>
  (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText() === name;

/** Whether an init or options argument sets `signal` where the call is written: in the object itself, or in both arms of a conditional. */
function setsSignal(argument: ts.Expression | undefined): boolean {
  if (!argument) return false;
  if (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument) || ts.isSatisfiesExpression(argument)) return setsSignal(argument.expression);
  if (ts.isConditionalExpression(argument)) return setsSignal(argument.whenTrue) && setsSignal(argument.whenFalse);
  return ts.isObjectLiteralExpression(argument) && argument.properties.some((property) => named(property, 'signal'));
}

/**
 * Whether a `fetchBounded` call hands over a fetcher written to set `signal`
 * on what it sends. That reaches the request but not the pause before a
 * retry, which only the signal in `init` ends, so it does not cover a call
 * with `retryTransient`.
 */
function joinsSignalInFetcher(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options) || options.properties.some((property) => named(property, 'retryTransient'))) return false;
  const fetcher = options.properties.find((property) => named(property, 'fetcher'));
  if (!fetcher || !ts.isPropertyAssignment(fetcher) || !ts.isArrowFunction(fetcher.initializer)) return false;
  const sets = (node: ts.Node): boolean => (ts.isExpression(node) && setsSignal(node)) || ts.forEachChild(node, sets) === true;
  return sets(fetcher.initializer.body);
}

/** The function a call is written in: the nearest enclosing one with a name, its own or the one it is assigned to. */
function enclosing(node: ts.Node): { name: string; scope: ts.Node } {
  for (let scope = node.parent; !ts.isSourceFile(scope); scope = scope.parent) {
    if (!ts.isFunctionLike(scope)) continue;
    const holder = scope.name ? scope : scope.parent;
    const name = ts.isFunctionLike(holder) || ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)
      || ts.isPropertyDeclaration(holder) ? holder.name : undefined;
    if (name) return { name: name.getText(), scope };
  }
  return { name: '(module)', scope: node.getSourceFile() };
}

/** Whether a function listens for the abort of a signal, which is what ends a wait on a timer set by hand. */
function listensForAbort(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener') {
    const [event] = node.arguments;
    if (event && ts.isStringLiteralLike(event) && event.text === 'abort') return true;
  }
  return ts.forEachChild(node, listensForAbort) === true;
}

interface Site { transport: string; where: string; line: number; signalled: boolean }

const sites: Site[] = program.getSourceFiles().flatMap((source) => {
  const file = path.relative(root, source.fileName);
  if (!/^(?:carriers|providers)\//.test(file)) return [];
  const found: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const transport = transportOf(node);
      if (transport) {
        const { name, scope } = enclosing(node);
        found.push({
          transport, where: `${file} ${name}`, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          signalled: transport === TIMER.name ? listensForAbort(scope)
            : setsSignal(node.arguments[TRANSPORTS[transport]!.argument])
              || (transport === 'fetchBounded' && joinsSignalInFetcher(node.arguments[2])),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
});

describe('transport calls and timers in carriers and providers', () => {
  it('are found for every transport and timer the scan knows', () => {
    expect([...Object.keys(TRANSPORTS), TIMER.name].filter((transport) => !sites.some((site) => site.transport === transport))).toEqual([]);
  });

  it('take the signal of their lookup', () => {
    expect(sites.filter((site) => !site.signalled && !Object.hasOwn(WITHOUT_SIGNAL, site.where))
      .map((site) => `${site.where} (line ${site.line}): ${site.transport}`)).toEqual([]);
  });

  it('are exempt only where a call is written without one', () => {
    expect(Object.keys(WITHOUT_SIGNAL).filter((where) => !sites.some((site) => site.where === where && !site.signalled))).toEqual([]);
  });
});
