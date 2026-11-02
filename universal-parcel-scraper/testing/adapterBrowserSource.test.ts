/**
 * `tracking.browser` marks the carriers whose lookups can open a browser, so
 * consumers can space out repeated lookups. An adapter reaches a browser only
 * through its environment: the browser service in `trawl`, the local Chromium
 * at `browserExecutablePath`, or a remote one through `withRemoteBrowser` at an
 * endpoint its `env` names. It never builds its own client for the browser
 * service from a URL, a browser this scan would not see. The scan follows
 * each registered adapter from its factory through the functions, classes and
 * values it names, across modules, and finds where that code reads one of
 * them. A helper shared with another carrier's folder counts; a class's caller
 * that never hands it the browser does not. A carrier served by another
 * folder's adapter takes its answer.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const carriersDirectory = path.join(root, 'carriers');

/** The environment's browsers, by the interface that declares them. */
const ENVIRONMENT = { module: 'core/adapter/index.ts', name: 'AdapterEnvironment', properties: ['trawl', 'trawlRoutes', 'browserExecutablePath'] };
/** The remote browser, whose endpoint an adapter reads from its `env`. */
const REMOTE = { module: 'core/transport/localBrowser.ts', name: 'withRemoteBrowser' };
/** The browser service's client, which only the host builds. */
const CLIENT = { module: 'core/transport/trawl.ts', name: 'TrawlClient' };

/**
 * The runner steps that can open a browser: the browser service's (`trawl`), a
 * local or remote Chromium's (`browser`), and DPD's consignee page (`page`),
 * which the browser service renders when one is configured.
 */
const BROWSER_STEPS = ['trawl', 'browser', 'page'];

interface Carrier { id: string; tracking: { adapter: string | null; steps: string[]; browser?: boolean } }

const carriers: Carrier[] = readdirSync(carriersDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(path.join(carriersDirectory, entry.name, 'carrier.json'), 'utf8')) as Carrier);
const adapterFolders = carriers.map((carrier) => carrier.id)
  .filter((folder) => ts.sys.fileExists(path.join(carriersDirectory, folder, 'adapter.ts')));

const { config } = ts.readConfigFile(path.join(root, 'tsconfig.json'), (file) => ts.sys.readFile(file));
const program = ts.createProgram(
  adapterFolders.map((folder) => path.join(carriersDirectory, folder, 'adapter.ts')),
  ts.convertCompilerOptionsFromJson(config.compilerOptions, root).options,
);
const checker = program.getTypeChecker();
const relative = (node: ts.Node) => path.relative(root, node.getSourceFile().fileName);

const environment = program.getSourceFile(path.join(root, ENVIRONMENT.module))!.statements
  .find((statement): statement is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(statement) && statement.name.text === ENVIRONMENT.name)!;
/** The `trawl` and `browserExecutablePath` members of the environment. */
const BROWSER_SETTINGS = new Set<ts.Node>(environment.members.filter((member) => ENVIRONMENT.properties.includes(member.name?.getText() ?? '')));

/** Declarations that hold no code, only types. */
const TYPE_ONLY = new Set([ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.PropertySignature, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.ModuleDeclaration]);

/** The project's code a symbol is declared in, through import aliases. */
function declarationsOf(symbol: ts.Symbol | undefined): ts.Declaration[] {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return (symbol?.declarations ?? []).filter((declaration) => !declaration.getSourceFile().isDeclarationFile
    && !relative(declaration).startsWith('node_modules') && !TYPE_ONLY.has(declaration.kind));
}

/** Whether a property, read under one of their names, is one of the environment's browsers. */
const isBrowserSetting = (name: ts.Node, symbol: () => ts.Symbol | undefined) => ts.isIdentifier(name)
  && ENVIRONMENT.properties.includes(name.text) && Boolean(symbol()?.declarations?.some((declaration) => BROWSER_SETTINGS.has(declaration)));

interface Facts { sites: string[]; builds: string[]; named: ts.Node[] }
const factsByDeclaration = new Map<ts.Node, Facts>();

/**
 * What a declaration's code reads of the browsers, and the declarations it
 * names. Types are skipped: they never run. A member is reached through its
 * class or object, which is visited whole, so property names are not resolved.
 */
function factsOf(declaration: ts.Node): Facts {
  const known = factsByDeclaration.get(declaration);
  if (known) return known;
  const facts: Facts = { sites: [], builds: [], named: [] };
  factsByDeclaration.set(declaration, facts);
  const where = (node: ts.Node) => `${relative(node)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const site = (node: ts.Node, what: string) => facts.sites.push(`${where(node)} ${what}`);
  const visit = (node: ts.Node | undefined): void => {
    if (!node) return;
    if (ts.isHeritageClause(node)) {
      // A base class's code runs; an implemented interface has none.
      if (node.token === ts.SyntaxKind.ExtendsKeyword) node.types.forEach((type) => visit(type.expression));
      return;
    }
    if (ts.isTypeNode(node) || TYPE_ONLY.has(node.kind) || ts.isImportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node)) {
      if (isBrowserSetting(node.name, () => checker.getSymbolAtLocation(node.name))) site(node, node.name.text);
      visit(node.expression);
      return;
    }
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      if (ts.isObjectBindingPattern(node.parent)
        && isBrowserSetting(name, () => checker.getTypeAtLocation(node.parent).getProperty(name.getText()))) site(node, name.getText());
      visit(node.name);
      visit(node.initializer);
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      facts.named.push(...declarationsOf(checker.getShorthandAssignmentValueSymbol(node)));
      visit(node.objectAssignmentInitializer);
      return;
    }
    if (ts.isIdentifier(node)) {
      // A declaration's own name names nothing else.
      if ((node.parent as { name?: ts.Node }).name === node) return;
      const declarations = declarationsOf(checker.getSymbolAtLocation(node));
      if (declarations.some((found) => relative(found) === REMOTE.module && ts.isFunctionDeclaration(found) && found.name?.text === REMOTE.name)) {
        site(node, REMOTE.name);
      }
      // Types are skipped above, so the class is named here as a value: constructed, or a static call.
      if (declarations.some((found) => relative(found) === CLIENT.module && ts.isClassDeclaration(found) && found.name?.text === CLIENT.name)) {
        facts.builds.push(`${where(node)} ${CLIENT.name}`);
      }
      facts.named.push(...declarations);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return facts;
}

/** Where the code an adapter folder's factory reaches reads one of the browsers, and where it names the service's client. */
function browserReads(folder: string): { sites: string[]; builds: string[] } {
  const source = program.getSourceFile(path.join(carriersDirectory, folder, 'adapter.ts'))!;
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find((symbol) => symbol.name === 'adapter');
  const pending: ts.Node[] = declarationsOf(exported);
  const seen = new Set<ts.Node>(pending);
  const sites: string[] = [];
  const builds: string[] = [];
  while (pending.length) {
    const facts = factsOf(pending.pop()!);
    sites.push(...facts.sites);
    builds.push(...facts.builds);
    for (const next of facts.named) {
      if (!seen.has(next)) { seen.add(next); pending.push(next); }
    }
  }
  return { sites: [...new Set(sites)].sort(), builds: [...new Set(builds)].sort() };
}

const readsByFolder = new Map(adapterFolders.map((folder) => [folder, browserReads(folder)]));
const sitesByFolder = new Map([...readsByFolder].map(([folder, reads]) => [folder, reads.sites]));
/** Each carrier's browser reads, through the adapter that serves it; none for universal and link-only carriers. */
const sitesOf = (carrier: Carrier) => sitesByFolder.get(carrier.tracking.adapter ?? '') ?? [];

describe('tracking.browser', () => {
  it('finds each way an adapter reaches a browser', () => {
    const found = [...sitesByFolder.values()].flat().map((site) => site.split(' ')[1]);
    expect([...ENVIRONMENT.properties, REMOTE.name].filter((name) => !found.includes(name))).toEqual([]);
  });

  it('is declared by every carrier whose adapter can open a browser', () => {
    expect(carriers.filter((carrier) => sitesOf(carrier).length && carrier.tracking.browser !== true)
      .map((carrier) => `${carrier.id}: ${sitesOf(carrier)[0]}`)).toEqual([]);
  });

  it('follows adapters that leave the browser service to their environment', () => {
    expect([...readsByFolder].filter(([, { builds }]) => builds.length).map(([folder, { builds }]) => `${folder}: ${builds[0]}`)).toEqual([]);
  });

  it('is declared only by carriers whose adapter can open a browser', () => {
    expect(carriers.filter((carrier) => carrier.tracking.browser === true && !sitesOf(carrier).length)
      .map((carrier) => `${carrier.id} (adapter ${carrier.tracking.adapter})`)).toEqual([]);
  });

  it('is declared exactly by the carriers that list a browser step', () => {
    const listed = (carrier: Carrier) => carrier.tracking.steps.some((step) => BROWSER_STEPS.includes(step));
    expect(carriers.filter((carrier) => listed(carrier) !== (carrier.tracking.browser === true))
      .map((carrier) => `${carrier.id}: ${carrier.tracking.steps.join(', ') || 'no steps'}`)).toEqual([]);
    expect(BROWSER_STEPS.filter((step) => !carriers.some((carrier) => carrier.tracking.steps.includes(step)))).toEqual([]);
  });
});
