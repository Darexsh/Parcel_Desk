/**
 * A Blazor Server app's HTML is an empty shell: the server renders the page
 * over a SignalR connection, as binary batches of changes to a tree of
 * elements. This module holds the parts of that protocol an adapter speaks,
 * without any request: SignalR's length-prefixed messages, the MessagePack
 * subset of its `blazorpack` hub protocol, the render batch layout, and a
 * document the batches apply to, written out as HTML for a parser. The
 * layouts follow ASP.NET Core's `RenderBatchWriter` and the edits its browser
 * renderer applies, from ASP.NET Core 5 to 8.
 */
import { isRecord } from '../types.js';

/** A part of the protocol that does not fit its layout. The circuit reports it as its carrier's schema failure. */
export class MalformedBlazorError extends Error {
  constructor(readonly part: 'message' | 'render batch') {
    super(`Blazor Server sent a malformed ${part}`);
    this.name = 'MalformedBlazorError';
  }
}

const malformed = (part: MalformedBlazorError['part']) => new MalformedBlazorError(part);

/** A MessagePack value as the hub sends it. Maps are objects; binaries stay bytes. */
export type Packed = null | boolean | number | bigint | string | Uint8Array | Packed[] | { [key: string]: Packed };

const MAX_DEPTH = 16;
const decoder = new TextDecoder('utf-8', { fatal: false });

/** One MessagePack value filling `bytes`. */
function unpack(bytes: Uint8Array): Packed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const take = (count: number) => {
    if (count > bytes.length - at) throw malformed('message');
    at += count;
    return at - count;
  };
  const text = (count: number) => decoder.decode(bytes.subarray(take(count), at));
  const binary = (count: number) => bytes.subarray(take(count), at);
  const list = (count: number, depth: number): Packed[] => {
    // Every value takes at least a byte.
    if (count > bytes.length - at) throw malformed('message');
    return Array.from({ length: count }, () => read(depth + 1));
  };
  const map = (count: number, depth: number): { [key: string]: Packed } => {
    if (count > bytes.length - at) throw malformed('message');
    return Object.fromEntries(Array.from({ length: count }, () => {
      const key = read(depth + 1);
      if (typeof key !== 'string' && typeof key !== 'number') throw malformed('message');
      return [String(key), read(depth + 1)];
    }));
  };
  const read = (depth: number): Packed => {
    if (depth > MAX_DEPTH) throw malformed('message');
    const head = bytes[take(1)]!;
    if (head <= 0x7f) return head;
    if (head >= 0xe0) return head - 0x100;
    if (head >= 0xa0 && head <= 0xbf) return text(head & 0x1f);
    if (head >= 0x90 && head <= 0x9f) return list(head & 0x0f, depth);
    if (head >= 0x80 && head <= 0x8f) return map(head & 0x0f, depth);
    switch (head) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return binary(view.getUint8(take(1)));
      case 0xc5: return binary(view.getUint16(take(2)));
      case 0xc6: return binary(view.getUint32(take(4)));
      case 0xca: return view.getFloat32(take(4));
      case 0xcb: return view.getFloat64(take(8));
      case 0xcc: return view.getUint8(take(1));
      case 0xcd: return view.getUint16(take(2));
      case 0xce: return view.getUint32(take(4));
      case 0xcf: return view.getBigUint64(take(8));
      case 0xd0: return view.getInt8(take(1));
      case 0xd1: return view.getInt16(take(2));
      case 0xd2: return view.getInt32(take(4));
      case 0xd3: return view.getBigInt64(take(8));
      case 0xd9: return text(view.getUint8(take(1)));
      case 0xda: return text(view.getUint16(take(2)));
      case 0xdb: return text(view.getUint32(take(4)));
      case 0xdc: return list(view.getUint16(take(2)), depth);
      case 0xdd: return list(view.getUint32(take(4)), depth);
      case 0xde: return map(view.getUint16(take(2)), depth);
      case 0xdf: return map(view.getUint32(take(4)), depth);
      default: throw malformed('message');
    }
  };
  const value = read(0);
  if (at !== bytes.length) throw malformed('message');
  return value;
}

/** A 7-bit variable-length count at `at`: its value and where it ends. */
function varint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    if (at >= bytes.length) break;
    const byte = bytes[at++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, at];
  }
  throw malformed('message');
}

/** The hub messages in a reply: each a MessagePack value after its length. */
export function unpackMessages(bytes: Uint8Array): Packed[] {
  const messages: Packed[] = [];
  for (let at = 0; at < bytes.length;) {
    const [length, start] = varint(bytes, at);
    if (length > bytes.length - start) throw malformed('message');
    messages.push(unpack(bytes.subarray(start, start + length)));
    at = start + length;
  }
  return messages;
}

/** One hub message: the MessagePack value after its length. Integers are written unsigned, up to 32 bits. */
export function packMessage(value: Packed): Uint8Array<ArrayBuffer> {
  const body: number[] = [];
  const size = (length: number, small: number, codes: readonly [number, number, number], smallLimit: number) => {
    if (length < smallLimit) body.push(small | length);
    else if (codes[0] && length < 0x100) body.push(codes[0], length);
    else if (length < 0x10000) body.push(codes[1], length >> 8, length & 0xff);
    else body.push(codes[2], length >>> 24, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
  };
  const write = (item: Packed): void => {
    if (item === null) body.push(0xc0);
    else if (typeof item === 'boolean') body.push(item ? 0xc3 : 0xc2);
    else if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < 0 || item > 0xffffffff) throw new TypeError('Only 32-bit unsigned integers are written');
      if (item < 0x80) body.push(item);
      else if (item < 0x100) body.push(0xcc, item);
      else if (item < 0x10000) body.push(0xcd, item >> 8, item & 0xff);
      else body.push(0xce, item >>> 24, (item >> 16) & 0xff, (item >> 8) & 0xff, item & 0xff);
    } else if (typeof item === 'string') {
      const encoded = new TextEncoder().encode(item);
      size(encoded.length, 0xa0, [0xd9, 0xda, 0xdb], 32);
      for (const byte of encoded) body.push(byte);
    } else if (item instanceof Uint8Array) {
      size(item.length, 0, [0xc4, 0xc5, 0xc6], 0);
      for (const byte of item) body.push(byte);
    } else if (Array.isArray(item)) {
      size(item.length, 0x90, [0, 0xdc, 0xdd], 16);
      item.forEach(write);
    } else if (typeof item === 'object') {
      const entries = Object.entries(item);
      size(entries.length, 0x80, [0, 0xde, 0xdf], 16);
      for (const [key, entry] of entries) {
        write(key);
        write(entry);
      }
    } else throw new TypeError('Unsupported MessagePack value');
  };
  write(value);
  const prefix: number[] = [];
  let length = body.length;
  do {
    prefix.push((length & 0x7f) | (length > 0x7f ? 0x80 : 0));
    length >>>= 7;
  } while (length);
  return new Uint8Array([...prefix, ...body]);
}

/** A prerendered marker the shell carries for each component the server renders. */
export interface ServerComponent {
  type: 'server';
  sequence: number;
  descriptor: string;
}

/** The server components a Blazor shell asks the circuit to render, in order. */
export function serverComponents(html: string): ServerComponent[] {
  const components: ServerComponent[] = [];
  for (const [, json] of html.matchAll(/<!--Blazor:(\{[^<>]{1,8000}?\})-->/g)) {
    let value: unknown;
    try { value = JSON.parse(json!); } catch { continue; }
    if (isRecord(value) && value.type === 'server' && Number.isSafeInteger(value.sequence) && typeof value.descriptor === 'string'
      && value.descriptor) components.push({ type: 'server', sequence: value.sequence as number, descriptor: value.descriptor });
  }
  return components;
}

/** The component state the shell hands the circuit's start, as the browser passes it on; none is empty. */
export function componentState(html: string): string {
  return /<!--Blazor-Server-Component-State:([\w+/=-]{1,65536})-->/.exec(html)?.[1] ?? '';
}

/** One entry of a batch's reference frames, each a fixed 20 bytes. */
export type Frame =
  | { type: 'element'; length: number; name: string }
  | { type: 'text'; text: string }
  | { type: 'attribute'; name: string; value: string | null }
  | { type: 'component'; length: number; id: number }
  | { type: 'region'; length: number }
  | { type: 'markup'; markup: string }
  // Element and component reference captures, and ASP.NET Core 8's render
  // mode and named event frames, take a frame and no node.
  | { type: 'capture' };

/** One change to a component's nodes; `reference` is a frame index, or the target of a move. */
export interface Edit {
  type: number;
  sibling: number;
  reference: number;
  removed: string | null;
}

export interface RenderBatch {
  diffs: { componentId: number; edits: Edit[] }[];
  frames: Frame[];
  disposed: number[];
}

const MAX_ITEMS = 200_000;

/** A render batch's bytes: its sections, then a string table, then five little-endian offsets. */
export function readRenderBatch(bytes: Uint8Array): RenderBatch {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 20;
  const int = (at: number) => {
    if (!Number.isInteger(at) || at < 0 || at > bytes.length - 4) throw malformed('render batch');
    return view.getInt32(at, true);
  };
  /** A count of fixed-size entries after `at`, all of them before the offsets. */
  const count = (at: number, size: number) => {
    const value = int(at);
    if (value < 0 || value > MAX_ITEMS || at + 4 + value * size > end) throw malformed('render batch');
    return value;
  };
  if (end < 0) throw malformed('render batch');
  const [updated, references, disposedAt, , table] = [0, 4, 8, 12, 16].map((offset) => int(end + offset)) as
    [number, number, number, number, number];
  if (table < 0 || table > end || (end - table) % 4) throw malformed('render batch');
  const strings = new Map<number, string>();
  const string = (index: number): string | null => {
    if (index === -1) return null;
    if (index < 0 || index >= (end - table) / 4) throw malformed('render batch');
    const known = strings.get(index);
    if (known !== undefined) return known;
    const [length, start] = varint(bytes, int(table + index * 4));
    if (length > bytes.length - start) throw malformed('render batch');
    const value = decoder.decode(bytes.subarray(start, start + length));
    strings.set(index, value);
    return value;
  };
  const named = (index: number) => {
    const value = string(index);
    if (value === null) throw malformed('render batch');
    return value;
  };
  const subtree = (length: number) => {
    if (length < 1) throw malformed('render batch');
    return length;
  };

  const frames: Frame[] = [];
  for (let index = 0, total = count(references, 20); index < total; index++) {
    const at = references + 4 + index * 20;
    const [first, second] = [int(at + 4), int(at + 8)];
    switch (int(at)) {
      case 1: frames.push({ type: 'element', length: subtree(first), name: named(second) }); break;
      case 2: frames.push({ type: 'text', text: string(first) ?? '' }); break;
      case 3: frames.push({ type: 'attribute', name: named(first), value: string(second) }); break;
      case 4: frames.push({ type: 'component', length: subtree(first), id: second }); break;
      case 5: frames.push({ type: 'region', length: subtree(first) }); break;
      case 6: case 7: case 9: case 10: frames.push({ type: 'capture' }); break;
      case 8: frames.push({ type: 'markup', markup: string(first) ?? '' }); break;
      default: throw malformed('render batch');
    }
  }
  const diffs: RenderBatch['diffs'] = [];
  for (let index = 0, total = count(updated, 4); index < total; index++) {
    const at = int(updated + 4 + index * 4);
    const componentId = int(at);
    const edits: Edit[] = [];
    for (let edit = 0, edited = count(at + 4, 16); edit < edited; edit++) {
      const from = at + 8 + edit * 16;
      edits.push({ type: int(from), sibling: int(from + 4), reference: int(from + 8), removed: string(int(from + 12)) });
    }
    diffs.push({ componentId, edits });
  }
  const disposed = Array.from({ length: count(disposedAt, 4) }, (_, index) => int(disposedAt + 4 + index * 4));
  return { diffs, frames, disposed };
}

interface ElementNode { kind: 'element'; name: string; attributes: Map<string, string>; children: PageNode[]; parent: Container }
interface ComponentNode { kind: 'component'; children: PageNode[] }
type Container = ElementNode | ComponentNode;
type PageNode = Container | { kind: 'text'; text: string } | { kind: 'markup'; markup: string };

const MAX_NODES = 100_000;
const MAX_NESTING = 256;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const NAME = /^[A-Za-z][\w:.-]*$/;
const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page as the batches build it. Each component is a container whose
 * children are its own nodes; a parent holds the container where the child
 * component sits, as the browser renderer's logical elements do.
 */
export class RenderedPage {
  readonly #components = new Map<number, ComponentNode>();
  #nodes = 0;

  #component(id: number): ComponentNode {
    let component = this.#components.get(id);
    if (!component) this.#components.set(id, component = { kind: 'component', children: [] });
    return component;
  }

  #place(parent: Container, index: number, node: PageNode): void {
    if (index > parent.children.length || ++this.#nodes > MAX_NODES) throw malformed('render batch');
    parent.children.splice(index, 0, node);
  }

  /** Inserts the frame at `at` with its subtree; returns how many nodes it adds to `parent`. */
  #insert(parent: Container, index: number, frames: readonly Frame[], at: number, depth = 0): number {
    const frame = frames[at];
    if (depth > MAX_NESTING) throw malformed('render batch');
    switch (frame?.type) {
      case 'element': {
        if (!NAME.test(frame.name)) throw malformed('render batch');
        const element: ElementNode = { kind: 'element', name: frame.name.toLowerCase(), attributes: new Map(), children: [], parent };
        this.#place(parent, index, element);
        const end = at + frame.length;
        let next = at + 1;
        // Attributes lead an element's frames.
        for (; next < end && frames[next]?.type === 'attribute'; next++) attribute(element, frames[next]!);
        this.#insertRange(element, 0, frames, next, end, depth + 1);
        return 1;
      }
      case 'text': this.#place(parent, index, { kind: 'text', text: frame.text }); return 1;
      case 'markup': this.#place(parent, index, { kind: 'markup', markup: frame.markup }); return 1;
      case 'component': this.#place(parent, index, this.#component(frame.id)); return 1;
      case 'region': return this.#insertRange(parent, index, frames, at + 1, at + frame.length, depth + 1);
      case 'capture': return 0;
      default: throw malformed('render batch');
    }
  }

  #insertRange(parent: Container, index: number, frames: readonly Frame[], start: number, end: number, depth: number): number {
    if (end > frames.length) throw malformed('render batch');
    let inserted = 0;
    for (let at = start; at < end;) {
      const frame = frames[at]!;
      inserted += this.#insert(parent, index + inserted, frames, at, depth);
      at += 'length' in frame ? frame.length : 1;
    }
    return inserted;
  }

  apply(batch: RenderBatch): void {
    for (const { componentId, edits } of batch.diffs) {
      let parent: Container = this.#component(componentId);
      let moves: { from: number; to: number }[] = [];
      for (const edit of edits) {
        const child = () => {
          const node = parent.children[edit.sibling];
          if (!node) throw malformed('render batch');
          return node;
        };
        const frame = batch.frames[edit.reference];
        switch (edit.type) {
          case 1: this.#insert(parent, edit.sibling, batch.frames, edit.reference); break;
          case 2: child(); parent.children.splice(edit.sibling, 1); break;
          case 3: {
            const element = child();
            if (element.kind !== 'element' || frame?.type !== 'attribute') throw malformed('render batch');
            attribute(element, frame);
            break;
          }
          case 4: {
            const element = child();
            if (element.kind !== 'element' || edit.removed === null) throw malformed('render batch');
            element.attributes.delete(edit.removed.toLowerCase());
            break;
          }
          case 5: {
            const node = child();
            if (node.kind !== 'text' || frame?.type !== 'text') throw malformed('render batch');
            node.text = frame.text;
            break;
          }
          case 6: {
            const element = child();
            if (element.kind !== 'element') throw malformed('render batch');
            parent = element;
            break;
          }
          case 7:
            if (parent.kind !== 'element') throw malformed('render batch');
            parent = parent.parent;
            break;
          case 8:
            child();
            if (frame?.type !== 'markup') throw malformed('render batch');
            parent.children[edit.sibling] = { kind: 'markup', markup: frame.markup };
            break;
          case 9: moves.push({ from: edit.sibling, to: edit.reference }); break;
          case 10: {
            const before = [...parent.children];
            for (const { from, to } of moves) {
              if (!before[from] || to < 0 || to >= before.length) throw malformed('render batch');
              parent.children[to] = before[from]!;
            }
            moves = [];
            break;
          }
          default: throw malformed('render batch');
        }
      }
    }
    for (const id of batch.disposed) this.#components.delete(id);
  }

  /** The HTML of a component the server attached, with its child components in place. */
  html(componentId: number): string {
    const root = this.#components.get(componentId);
    if (!root) return '';
    const open = new Set<ComponentNode>();
    const write = (node: PageNode, depth: number): string => {
      if (depth > 4 * MAX_NESTING) throw malformed('render batch');
      switch (node.kind) {
        case 'text': return escapeText(node.text);
        case 'markup': return node.markup;
        case 'component': {
          // A component inside itself is no page.
          if (open.has(node)) throw malformed('render batch');
          open.add(node);
          const html = node.children.map((child) => write(child, depth + 1)).join('');
          open.delete(node);
          return html;
        }
        case 'element': {
          const attributes = [...node.attributes].filter(([name]) => NAME.test(name))
            .map(([name, value]) => ` ${name}="${escapeText(value).replace(/"/g, '&quot;')}"`).join('');
          if (VOID.has(node.name)) return `<${node.name}${attributes}>`;
          return `<${node.name}${attributes}>${node.children.map((child) => write(child, depth + 1)).join('')}</${node.name}>`;
        }
      }
    };
    return write(root, 0);
  }
}

/** An attribute frame on an element: a value sets it, none removes it, as event handlers carry none. */
function attribute(element: ElementNode, frame: Frame): void {
  if (frame.type !== 'attribute') throw malformed('render batch');
  const name = frame.name.toLowerCase();
  if (frame.value === null) element.attributes.delete(name);
  else element.attributes.set(name, frame.value);
}
