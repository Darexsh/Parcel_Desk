/**
 * The id of the server action TracX Logis's tracking page calls for a parcel's
 * history, read from the page's client chunks. Next builds the page's
 * reference with `createServerReference("<id>", …, "getTrackingHistory")`:
 * only an id bound to that name counts, since the same module registers the
 * page's other actions next to it.
 */

/** Chunks read per discovery, the last ones the tracking view loads first. */
export const MAX_CHUNKS = 8;

const SCRIPT = /<script\b([^>]*)>/gi;
const SOURCE = /\bsrc\s*=\s*["']([^"'<>]+)["']/i;
const CHUNK_PATH = /\/_next\/static\/chunks\/[\w.-]+\.js/g;
// The tracking view's client module, with the chunks it loads, in the page's own server components.
const VIEW = /I\[\d+,\[([^\]]{0,8000})\],\\*"TrackingContent\\*"\]/;
// The page streams its server components in pieces, which can split a row.
const PIECE_BREAK = /"\]\)<\/script><script\b[^>]*>self\.__next_f\.push\(\[1,"/g;
const LOOKUP = /createServerReference\)\(\s*"([0-9a-f]{40,42})"\s*,[\w$.\s,]{0,200}?,\s*"getTrackingHistory"\s*\)/;

/** Fetches a chunk's text within the bytes it may have. */
export type ChunkReader = (url: string) => Promise<string>;

/**
 * The chunks the tracking view loads, in the page's order; when the page no
 * longer names the view, every chunk its scripts load, except the
 * polyfills older browsers take instead.
 */
export function viewChunks(html: string, page: string): string[] {
  const origin = new URL(page).origin;
  const listed = VIEW.exec(html.replace(PIECE_BREAK, ''))?.[1];
  const paths = listed !== undefined ? [...listed.matchAll(CHUNK_PATH)].map(([path]) => path)
    : [...html.matchAll(SCRIPT)].map(([, attributes = '']) => attributes).filter(attributes => !/\bnomodule\b/i.test(attributes))
      .flatMap(attributes => SOURCE.exec(attributes)?.[1] ?? []);
  const chunks: string[] = [];
  for (const path of paths) {
    let url: URL;
    try {
      url = new URL(path.replace(/&amp;/g, '&'), page);
    } catch {
      continue;
    }
    if (url.origin !== origin || !/^\/_next\/static\/chunks\/[\w.-]+\.js$/.test(url.pathname)) continue;
    if (!chunks.includes(url.href)) chunks.push(url.href);
  }
  return chunks;
}

/** The id a chunk binds to the history lookup, if it builds that reference. */
export function lookupActionId(source: string): string | undefined {
  return LOOKUP.exec(source)?.[1];
}

/**
 * The action id the page's chunks bind to the history lookup. The view's own
 * code comes after the shared chunks it loads, so the chunks are read from the
 * last one back, one at a time, and never more than `MAX_CHUNKS`.
 */
export async function discoverActionId(html: string, page: string, read: ChunkReader): Promise<string | undefined> {
  for (const chunk of viewChunks(html, page).reverse().slice(0, MAX_CHUNKS)) {
    const found = lookupActionId(await read(chunk));
    if (found !== undefined) return found;
  }
  return undefined;
}
