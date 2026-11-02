/**
 * The id of the server action NIPOST's tracking page calls, read from the
 * client chunks the page loads. The page awaits `(0,m.X)(number)` and reads
 * `.data` and `.error` from what it returns. Module `m` exports `X` as a
 * reference built from the id by `createServerReference`, directly or through
 * a module that wraps it. Only an id bound that way counts; the other ids a
 * module registers belong to other actions.
 */
import { escapeRegExp } from '../../core/transport/index.js';

/** Chunks read per discovery: the route's own, then the shared ones it loads. */
export const MAX_CHUNKS = 6;
const MAX_ROUTE_CHUNKS = 2;
// A module's body is searched up to the next module, and never past this.
const MAX_MODULE_CHARS = 20_000;

const SCRIPT = /<script\b[^>]*?\bsrc\s*=\s*["']([^"'<>]+)["']/gi;
const CHUNK_PATH = /^\/_next\/static\/chunks\/[\w%.[\]/-]+\.js$/;
// Next's runtime, React and polyfills hold no route code.
const RUNTIME = /^\/_next\/static\/chunks\/(?:webpack|polyfills|main-app|main|framework)-/;
const ROUTE = '/_next/static/chunks/app/';
const LOOKUP_CALL = /([\w$]+)\s*=\s*await\s*\(0,\s*([\w$]+)\.([\w$]+)\)\(\s*[\w$]+\s*\)\s*[;,]\s*[\w$]+\(\s*\1\.data\s*\)\s*[;,]\s*[\w$]+\(\s*\1\.error\s*\)/g;
const DEPENDENCIES = /\.O\(\s*0\s*,\s*\[([\d\s,]*)\]/;
const NEXT_MODULE = /\}\s*,\s*(?:\d+|"[^"]*")\s*:\s*(?:function\s*\(|\([\w$,\s]*\)\s*=>)/;

export interface LookupCall {
  /** The webpack module that exports the action reference. */
  module: string;
  /** The export the page calls. */
  name: string;
  /** Numeric ids of the shared chunks the route loads. */
  chunks: ReadonlySet<string>;
}

/** Fetches a chunk's text within the bytes it may have. */
export type ChunkReader = (url: string) => Promise<string>;

/** The page's own client chunks, in the order its script tags load them. */
export function pageChunks(html: string, page: string): string[] {
  const origin = new URL(page).origin;
  const chunks: string[] = [];
  for (const [, src = ''] of html.matchAll(SCRIPT)) {
    let url: URL;
    try {
      url = new URL(src.replace(/&amp;/g, '&'), page);
    } catch {
      continue;
    }
    if (url.origin !== origin || !CHUNK_PATH.test(url.pathname) || RUNTIME.test(url.pathname)) continue;
    if (!chunks.includes(url.href)) chunks.push(url.href);
  }
  return chunks;
}

const isRoute = (url: string) => new URL(url).pathname.startsWith(ROUTE);
const isPage = (url: string) => /\/page-\w+\.js$/.test(new URL(url).pathname);

/** A variable's last `name = require(id)` before `end`. */
function requiredModule(source: string, variable: string, end = source.length): string | undefined {
  const declaration = new RegExp(String.raw`(?:^|[^\w$.])${escapeRegExp(variable)}\s*=\s*[\w$]+\(\s*(\d+)\s*\)`, 'g');
  let module: string | undefined;
  for (const match of source.slice(0, end).matchAll(declaration)) module = match[1];
  return module;
}

/** The one action call the route makes for a lookup, when its chunks make exactly one. */
export function lookupCall(sources: readonly string[]): LookupCall | undefined {
  const calls = new Map<string, LookupCall>();
  for (const source of sources) {
    for (const { 2: variable = '', 3: name = '', index } of source.matchAll(LOOKUP_CALL)) {
      const module = requiredModule(source, variable, index);
      if (module === undefined) continue;
      const chunks = new Set((DEPENDENCIES.exec(source)?.[1] ?? '').split(',').map(id => id.trim()).filter(Boolean));
      calls.set(`${module}:${name}`, { module, name, chunks });
    }
  }
  return calls.size === 1 ? [...calls.values()][0] : undefined;
}

/** A webpack module's body, up to where the next module starts. */
function moduleBody(sources: readonly string[], id: string): string | undefined {
  const start = new RegExp(String.raw`(?:^|[{,])\s*${id}\s*:\s*(?:function\s*\([\w$,\s]*\)|\([\w$,\s]*\)\s*=>)\s*\{`);
  for (const source of sources) {
    const match = start.exec(source);
    if (!match) continue;
    const body = source.slice(match.index + match[0].length, match.index + match[0].length + MAX_MODULE_CHARS);
    const next = NEXT_MODULE.exec(body);
    return next ? body.slice(0, next.index) : body;
  }
  return undefined;
}

/** The id the call's export is built from, when `createServerReference` builds it. */
export function actionId(sources: readonly string[], call: LookupCall): string | undefined {
  const body = moduleBody(sources, call.module);
  if (body === undefined) return undefined;
  const name = escapeRegExp(call.name);
  const getter = new RegExp(String.raw`[{,]\s*${name}\s*:\s*(?:function\s*\(\s*\)\s*\{\s*return\s+([\w$]+)\s*;?\s*\}|\(\s*\)\s*=>\s*([\w$]+))`).exec(body);
  const local = getter?.[1] ?? getter?.[2];
  if (local === undefined) return undefined;
  const reference = new RegExp(String.raw`(?:^|[^\w$.])${escapeRegExp(local)}\s*=\s*\(0,\s*([\w$]+)\.([\w$]+)\)\(\s*"([0-9a-f]{40,42})"`).exec(body);
  if (!reference) return undefined;
  const [, wrapper = '', member, id] = reference;
  if (member === 'createServerReference') return id;
  const wrapperModule = requiredModule(body, wrapper);
  if (wrapperModule === undefined) return undefined;
  return moduleBody(sources, wrapperModule)?.includes('createServerReference') ? id : undefined;
}

/**
 * The action id the page's chunks bind to the lookup. The route's chunks are
 * read first; the shared chunks it names are read only when the reference is
 * not among them, and never more than `MAX_CHUNKS` in all.
 */
export async function discoverActionId(html: string, page: string, read: ChunkReader): Promise<string | undefined> {
  const chunks = pageChunks(html, page);
  // A route's page chunk holds its code; its layouts come after it.
  const routes = chunks.filter(isRoute).sort((left, right) => Number(!isPage(left)) - Number(!isPage(right))).slice(0, MAX_ROUTE_CHUNKS);
  const sources = await Promise.all(routes.map(read));
  const call = lookupCall(sources);
  if (!call) return undefined;
  const found = actionId(sources, call);
  if (found !== undefined) return found;
  const shared = chunks.filter(url => !isRoute(url)).filter((url) => {
    const id = /^(\d+)-[0-9a-f]+\.js$/.exec(new URL(url).pathname.split('/').pop() ?? '')?.[1];
    return call.chunks.size === 0 || (id !== undefined && call.chunks.has(id));
  }).slice(0, MAX_CHUNKS - routes.length);
  return actionId([...sources, ...await Promise.all(shared.map(read))], call);
}
