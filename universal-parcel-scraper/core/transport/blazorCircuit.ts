/**
 * One lookup on a Blazor Server page, over SignalR long polling and with no
 * browser: the page's shell, the hub's negotiation and handshake, the start
 * of the page's circuit, then each render batch the server sends,
 * acknowledged as the browser does, and each call the page makes to its
 * scripts, answered, until the carrier reads an answer from the page. A
 * `DELETE` ends the connection, so the server drops the circuit at once.
 * Every request goes through the lookup's fetcher, signal and deadline.
 */
import { ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError } from '../errors/index.js';
import { isRecord } from '../types.js';
import { componentState, MalformedBlazorError, packMessage, readRenderBatch, RenderedPage, serverComponents, unpackMessages,
  type Packed } from './blazor.js';
import { decodeText, fetchBounded } from './boundedFetch.js';
import { userAgentOf } from './userAgent.js';

/** The page as the server has rendered it: the components it attached, in order, and whether it has started the page. */
export interface RenderedCircuit {
  page: RenderedPage;
  roots: readonly number[];
  started: boolean;
}

export interface BlazorPageLookup<T> {
  /** The provider the errors name. */
  provider: string;
  /** The carrier's name in the errors' messages. */
  name: string;
  /** The app's base address, which the circuit's start takes and its hub sits under. */
  app: string;
  /** The page to open. */
  page: string;
  /** The largest shell the app sends. */
  shellMaxBytes: number;
  fetcher?: typeof fetch;
  userAgent?: string;
  signal: AbortSignal;
  /** When the lookup's budget ends, on `performance.now()`'s clock. */
  deadline: number;
  /** ASP.NET Core 8's start also takes the component state the shell carries. */
  componentState?: boolean;
  /** Results for the page's script calls by identifier; any other call is answered as done, with none. */
  scripts?: Readonly<Record<string, Packed>>;
  /** Whether the page may move to `target`. Any other move is not the lookup's answer; by default none is followed. */
  follows?: (target: string) => boolean;
  /** The lookup's answer once the page shows one, or undefined while it does not. */
  answer: (circuit: RenderedCircuit) => T | undefined;
}

const HANDSHAKE = '{"protocol":"blazorpack","version":1}\u001e';
// SignalR's message types: a call, a call's result and the server's goodbye.
const INVOCATION = 1;
const COMPLETION = 3;
const CLOSE = 7;
// The id the circuit's start is called under, which its result answers.
const START = '0';
// A long history's batches are well under a megabyte.
const HUB_MAX_BYTES = 4 * 1024 * 1024;
const MAX_POLLS = 12;
const CLOSE_MS = 2_000;
// Bot checks a CDN or firewall could put in place of the shell.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required)|captcha/i;

/** Opens the page's circuit and reads it until the lookup's `answer` gives one. */
export function readBlazorPage<T>(lookup: BlazorPageLookup<T>): Promise<T> {
  return new Circuit(lookup).read();
}

class Circuit<T> {
  readonly #page = new RenderedPage();
  readonly #roots: number[] = [];
  readonly #hub: string;
  #url = '';
  #started = false;
  #closed = false;

  constructor(private readonly lookup: BlazorPageLookup<T>) {
    this.#hub = `${lookup.app}_blazor`;
  }

  async #request(url: string, method: 'GET' | 'POST' | 'DELETE', body?: string | Uint8Array<ArrayBuffer>,
    limits: { maxBytes?: number; timeoutMs?: number } = {}): Promise<{ status: number; bytes: Uint8Array }> {
    const { provider, name } = this.lookup;
    const { response, bytes } = await fetchBounded(url, { method, signal: this.lookup.signal, headers: {
      'User-Agent': userAgentOf(this.lookup.userAgent), 'X-Requested-With': 'XMLHttpRequest',
      ...(body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'text/plain;charset=UTF-8' : 'application/octet-stream' }),
    }, body }, { provider, timeoutMs: limits.timeoutMs ?? Math.max(1, Math.floor(this.lookup.deadline - performance.now())),
      maxBytes: limits.maxBytes ?? HUB_MAX_BYTES, redirect: 'manual', fetcher: this.lookup.fetcher,
      allowHttpStatuses: [301, 302, 303, 307, 308, 403, 404, 410, 429] });
    if (response.status === 429) throw new RateLimitedError(provider, undefined, `${name} refused the lookup for now`, { status: 429 });
    if (response.status === 403) throw new ChallengeError(provider, `${name} refused the lookup`, { status: 403 });
    if (response.status >= 300 && response.status < 400) throw new TransportError(provider, `${name} redirected its tracker`);
    if (response.status === 404 || response.status === 410) {
      throw new TransportError(provider, url.startsWith(this.#hub) ? `${name} dropped the tracker's connection` : `${name}'s tracker is unavailable`);
    }
    return { status: response.status, bytes };
  }

  /** What the server sent since the last poll; a 204 is its goodbye. */
  async #poll(): Promise<Uint8Array> {
    const { status, bytes } = await this.#request(this.#url, 'GET');
    if (status === 204) throw new TransportError(this.lookup.provider, `${this.lookup.name} closed the tracker's connection`);
    return bytes;
  }

  async #send(message: Packed): Promise<void> {
    await this.#request(this.#url, 'POST', packMessage(message));
  }

  /** Answers one call the server makes to the page's scripts. */
  async #invokeJs(args: Packed[]): Promise<void> {
    const { provider, name, scripts = {}, follows } = this.lookup;
    const [handle, identifier, json] = args;
    if (typeof handle !== 'number' || typeof identifier !== 'string') throw new SchemaError(provider, `${name} made an invalid page call`);
    if (identifier.endsWith('navigationManager.navigateTo')) {
      let target: unknown;
      try { [target] = JSON.parse(typeof json === 'string' ? json : '[]') as unknown[]; } catch { target = null; }
      if (typeof target !== 'string' || !follows?.(target)) throw new SchemaError(provider, `${name}'s tracker moved to another page`);
      await this.#send([INVOCATION, {}, null, 'OnLocationChanged', [target, false]]);
    }
    const result = Object.hasOwn(scripts, identifier) ? scripts[identifier]! : null;
    await this.#send([INVOCATION, {}, null, 'EndInvokeJSFromDotNet', [handle, true, JSON.stringify([handle, true, result])]]);
  }

  async #handle(bytes: Uint8Array): Promise<void> {
    const { provider, name } = this.lookup;
    for (const message of unpackMessages(bytes)) {
      if (!Array.isArray(message) || typeof message[0] !== 'number') throw new SchemaError(provider, `${name} returned an invalid message`);
      if (message[0] === CLOSE) {
        this.#closed = true;
        return;
      }
      if (message[0] === COMPLETION && message[2] === START) {
        // An error result, or none, is a page the server would not open.
        if (message[3] !== 3 || typeof message[4] !== 'string' || !message[4]) throw new TransportError(provider, `${name} did not open the tracking page`);
        this.#started = true;
      }
      if (message[0] !== INVOCATION) continue;
      const [, , , target, args] = message;
      if (typeof target !== 'string' || !Array.isArray(args)) throw new SchemaError(provider, `${name} returned an invalid message`);
      if (target === 'JS.AttachComponent') {
        if (typeof args[0] !== 'number') throw new SchemaError(provider, `${name} attached an invalid component`);
        this.#roots.push(args[0]);
      } else if (target === 'JS.RenderBatch') {
        const [id, batch] = args;
        if (typeof id !== 'number' || !(batch instanceof Uint8Array)) throw new SchemaError(provider, `${name} returned an invalid render batch`);
        this.#page.apply(readRenderBatch(batch));
        await this.#send([INVOCATION, {}, null, 'OnRenderCompleted', [id, null]]);
      } else if (target === 'JS.BeginInvokeJS') {
        await this.#invokeJs(args);
      } else if (target === 'JS.Error') {
        throw new IndeterminateError(provider, `${name}'s tracker failed while rendering the page`);
      }
    }
  }

  async read(): Promise<T> {
    try {
      return await this.#read();
    } catch (error) {
      if (error instanceof MalformedBlazorError) throw new SchemaError(this.lookup.provider, `${this.lookup.name} returned a malformed ${error.part}`);
      throw error;
    }
  }

  async #read(): Promise<T> {
    const { provider, name, app, page } = this.lookup;
    const shell = decodeText((await this.#request(page, 'GET', undefined, { maxBytes: this.lookup.shellMaxBytes })).bytes);
    const components = serverComponents(shell);
    if (!components.length) {
      if (CHALLENGE.test(shell.slice(0, 64_000))) throw new ChallengeError(provider, `${name} answered with a browser check`);
      throw new SchemaError(provider, `${name}'s tracking page changed`);
    }
    const negotiation = await this.#request(`${this.#hub}/negotiate?negotiateVersion=1`, 'POST', '');
    let reply: unknown;
    try { reply = JSON.parse(decodeText(negotiation.bytes)); } catch { reply = null; }
    const transports = isRecord(reply) && Array.isArray(reply.availableTransports) ? reply.availableTransports : [];
    const token = isRecord(reply) ? reply.connectionToken : null;
    if (typeof token !== 'string' || !/^[\w-]{1,200}$/.test(token)
      || !transports.some((item) => isRecord(item) && item.transport === 'LongPolling'
        && Array.isArray(item.transferFormats) && item.transferFormats.includes('Binary'))) {
      throw new SchemaError(provider, `${name}'s tracker offered no usable connection`);
    }
    this.#url = `${this.#hub}?id=${encodeURIComponent(token)}`;
    try {
      // The first poll finishes opening the connection and returns at once.
      await this.#poll();
      await this.#request(this.#url, 'POST', HANDSHAKE);
      let received = await this.#poll();
      const separator = received.indexOf(0x1e);
      let handshake: unknown;
      try { handshake = JSON.parse(decodeText(received.subarray(0, separator))); } catch { handshake = null; }
      if (separator < 0 || !isRecord(handshake) || handshake.error !== undefined) throw new SchemaError(provider, `${name} refused the tracker's protocol`);
      received = received.subarray(separator + 1);
      const start: Packed[] = [app, page, JSON.stringify(components)];
      if (this.lookup.componentState) start.push(componentState(shell));
      await this.#send([INVOCATION, {}, START, 'StartCircuit', start]);
      for (let polls = 0; ; polls++) {
        await this.#handle(received);
        const answer = this.lookup.answer({ page: this.#page, roots: this.#roots, started: this.#started });
        if (answer !== undefined) return answer;
        if (this.#closed) throw new TransportError(provider, `${name} closed the tracker's connection`);
        if (polls >= MAX_POLLS) throw new IndeterminateError(provider, `${name}'s tracker did not render an answer`);
        received = await this.#poll();
      }
    } finally {
      await this.#close();
    }
  }

  /** Ends the connection, so the server drops the circuit at once; a failure changes nothing. */
  async #close(): Promise<void> {
    if (this.lookup.signal.aborted) return;
    try {
      await this.#request(this.#url, 'DELETE', undefined, {
        timeoutMs: Math.max(1, Math.min(CLOSE_MS, Math.floor(this.lookup.deadline - performance.now()))) });
    } catch {
      // The server drops an idle circuit on its own.
    }
  }
}
