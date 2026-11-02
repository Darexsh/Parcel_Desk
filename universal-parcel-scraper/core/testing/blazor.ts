/**
 * Test helpers for a Blazor Server page: a render batch writer, the reverse of
 * ASP.NET Core's layout, the hub's messages, and a fake app that answers a
 * lookup's requests with its shell, its negotiation and a queue of long polls.
 */
import { load } from 'cheerio';
import type { ChildNode } from 'domhandler';
import { vi } from 'vitest';
import { packMessage, unpackMessages, type Frame, type Packed } from '../transport/blazor.js';

export const join = (...parts: Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((at, part) => (bytes.set(part, at), at + part.length), 0);
  return bytes;
};

// ASP.NET Core 8's render mode (9) and named event (10) frames, which take no node.
export type BatchFrame = Frame | { type: 'raw'; code: 9 | 10 };
export interface BatchEdit { type: number; sibling?: number; reference?: number; removed?: string }
export interface BatchSpec { diffs: { componentId: number; edits: BatchEdit[] }[]; frames: BatchFrame[]; disposed?: number[] }

export function writeBatch({ diffs, frames, disposed = [] }: BatchSpec): Uint8Array {
  const bytes: number[] = [];
  const int = (value: number) => {
    bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
  };
  const strings: string[] = [];
  const string = (value: string | null | undefined) => {
    if (value === null || value === undefined) return -1;
    const known = strings.indexOf(value);
    return known >= 0 ? known : strings.push(value) - 1;
  };
  const diffAt = diffs.map(({ componentId, edits }) => {
    const at = bytes.length;
    int(componentId);
    int(edits.length);
    for (const edit of edits) [edit.type, edit.sibling ?? 0, edit.reference ?? 0, string(edit.removed)].forEach(int);
    return at;
  });
  const updated = bytes.length;
  int(diffs.length);
  diffAt.forEach(int);
  const references = bytes.length;
  int(frames.length);
  for (const frame of frames) {
    const fields = frame.type === 'element' ? [1, frame.length, string(frame.name)]
      : frame.type === 'text' ? [2, string(frame.text)]
        : frame.type === 'attribute' ? [3, string(frame.name), string(frame.value)]
          : frame.type === 'component' ? [4, frame.length, frame.id]
            : frame.type === 'region' ? [5, frame.length]
              : frame.type === 'markup' ? [8, string(frame.markup)]
                : frame.type === 'raw' ? [frame.code] : [6];
    [...fields, 0, 0, 0, 0, 0].slice(0, 5).forEach(int);
  }
  const disposedAt = bytes.length;
  int(disposed.length);
  disposed.forEach(int);
  const handlers = bytes.length;
  int(0);
  const stringAt = strings.map((value) => {
    const at = bytes.length;
    const encoded = new TextEncoder().encode(value);
    let length = encoded.length;
    do {
      bytes.push((length & 0x7f) | (length > 0x7f ? 0x80 : 0));
      length >>>= 7;
    } while (length);
    bytes.push(...encoded);
    return at;
  });
  const table = bytes.length;
  stringAt.forEach(int);
  [updated, references, disposedAt, handlers, table].forEach(int);
  return new Uint8Array(bytes);
}

/** The frames of an HTML fragment, as the server writes an element's attributes before its children. */
export function htmlFrames(html: string): Frame[] {
  const framesOf = (nodes: readonly ChildNode[]): Frame[] => {
    const frames: Frame[] = [];
    for (const node of nodes) {
      if (node.nodeType === 3) frames.push({ type: 'text', text: node.data });
      if (node.nodeType !== 1 || !('attribs' in node)) continue;
      const at = frames.push({ type: 'capture' }) - 1;
      for (const [name, value] of Object.entries(node.attribs)) frames.push({ type: 'attribute', name, value });
      frames.push(...framesOf(node.children));
      frames[at] = { type: 'element', name: node.name, length: frames.length - at };
    }
    return frames;
  };
  return framesOf(load(html, null, false).root()[0]!.children);
}

// --- The hub's side of the connection.

export const invocation = (target: string, args: Packed[]) => packMessage([1, {}, null, target, args, []]);
export const render = (id: number, batch: Uint8Array) => invocation('JS.RenderBatch', [id, batch]);
/** The result of the circuit's start: a circuit id, or an error. */
export const started = (kind = 3, result: Packed = 'synthetic-circuit') => packMessage([3, {}, '0', kind, result]);
export const callJs = (handle: number, identifier: string, args: unknown[]) =>
  invocation('JS.BeginInvokeJS', [handle, identifier, JSON.stringify(args), 0, 0]);

export const HUB_TOKEN = 'synthetic-token_1';
const HANDSHAKE_REPLY = new TextEncoder().encode('{}\u001e');

export interface AppOptions {
  shell?: () => Response;
  negotiate?: () => Response;
  polls: (Uint8Array | (() => Response))[];
}

/**
 * A fake app at `app`, whose shell is any page under `page`: the hub's
 * negotiation, the long-poll answers after the opening poll and the
 * handshake, and the requests and messages the lookup sends.
 */
export function blazorApp({ app, page, shell, negotiate = () => Response.json({ negotiateVersion: 1, connectionId: 'synthetic',
  connectionToken: HUB_TOKEN, availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] },
    { transport: 'ServerSentEvents', transferFormats: ['Text'] }, { transport: 'LongPolling', transferFormats: ['Text', 'Binary'] }] }),
polls }: AppOptions & { app: string; page: string; shell: () => Response }) {
  const hub = `${app}_blazor`;
  const poll = `${hub}?id=${HUB_TOKEN}`;
  const queue = [new Uint8Array(), HANDSHAKE_REPLY, ...polls];
  const requests: string[] = [];
  const sent: Packed[] = [];
  const texts: string[] = [];
  const answer = (url: string, init: RequestInit | undefined): Response => {
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (url.startsWith(page) && method === 'GET') return shell();
    if (url === `${hub}/negotiate?negotiateVersion=1` && method === 'POST') return negotiate();
    if (url !== poll) throw new Error(`Unexpected request ${method} ${url}`);
    if (method === 'DELETE') return new Response(null, { status: 202 });
    if (method === 'POST') {
      if (typeof init?.body === 'string') texts.push(init.body);
      else sent.push(...unpackMessages(init!.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    const next = queue.shift() ?? new Uint8Array();
    return typeof next === 'function' ? next() : new Response(next as Uint8Array<ArrayBuffer>, { status: 200 });
  };
  const fetcher = vi.fn<typeof fetch>((input, init) =>
    Promise.resolve().then(() => answer(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)));
  return { fetcher, requests, sent, texts };
}
