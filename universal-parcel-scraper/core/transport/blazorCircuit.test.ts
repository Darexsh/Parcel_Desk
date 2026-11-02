import { describe, expect, it, vi } from 'vitest';
import { blazorApp, callJs, HUB_TOKEN, htmlFrames, invocation, join, render, started, writeBatch, type AppOptions } from '../testing/blazor.js';
import { packMessage } from './blazor.js';
import { readBlazorPage, type BlazorPageLookup } from './blazorCircuit.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';

const APP = 'https://tracker.example/app/';
const PAGE = `${APP}track/ZZ1`;
const POLL = `${APP}_blazor?id=${HUB_TOKEN}`;
const SHELL = '<html><body><!--Blazor:{"type":"server","sequence":0,"descriptor":"U3ludGhldGljRGVzY3JpcHRvcg+AA=="}-->'
  + '<!--Blazor-Server-Component-State:U3ludGhldGljU3RhdGU=--></body></html>';
const COMPONENTS = '[{"type":"server","sequence":0,"descriptor":"U3ludGhldGljRGVzY3JpcHRvcg+AA=="}]';

const app = (options: Partial<AppOptions>) => blazorApp({ app: APP, page: PAGE, shell: () => new Response(SHELL), polls: [], ...options });
const attach = () => invocation('JS.AttachComponent', [0, 'app']);
/** A root component holding the page's component, which renders the fragment. */
const pageBatch = (html: string) => {
  const page = htmlFrames(html);
  return writeBatch({ frames: [{ type: 'element', name: 'main', length: 2 }, { type: 'component', length: 1, id: 1 },
    { type: 'region', length: page.length + 1 }, ...page],
  diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }, { componentId: 1, edits: [{ type: 1, sibling: 0, reference: 2 }] }] });
};
const answered = () => join(attach(), render(2, pageBatch('<p>Found</p>')), started());

/** A lookup whose page answers with a paragraph, and with its unknown-number sentence once the server has started it. */
function lookup(fetcher: typeof fetch, options: Partial<BlazorPageLookup<string>> = {}): Promise<string> {
  return readBlazorPage({ provider: 'Example', name: 'Example Carrier', app: APP, page: PAGE, shellMaxBytes: 64 * 1024,
    fetcher, userAgent: 'SyntheticHost/1.0', signal: new AbortController().signal, deadline: performance.now() + 5_000,
    answer: ({ page, roots, started }) => {
      const html = roots.map((root) => page.html(root)).join('');
      if (html.includes('<p>Found</p>')) return 'found';
      return html.includes('Unknown number') && started ? 'unknown' : undefined;
    }, ...options });
}

describe('Blazor Server circuit', () => {
  it('opens the page’s circuit over long polling, through the supplied transport, and closes it', async () => {
    const { fetcher, requests, sent, texts } = app({ polls: [answered()] });
    await expect(lookup(fetcher)).resolves.toBe('found');
    expect(requests).toEqual([`GET ${PAGE}`, `POST ${APP}_blazor/negotiate?negotiateVersion=1`, `GET ${POLL}`, `POST ${POLL}`,
      `GET ${POLL}`, `POST ${POLL}`, `GET ${POLL}`, `POST ${POLL}`, `DELETE ${POLL}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    // The negotiation posts an empty body, as the server asks for a length.
    expect(fetcher.mock.calls[1]![1]!.body).toBe('');
    expect(texts).toEqual(['{"protocol":"blazorpack","version":1}\u001e']);
    expect(sent).toEqual([[1, {}, '0', 'StartCircuit', [APP, PAGE, COMPONENTS]], [1, {}, null, 'OnRenderCompleted', [2, null]]]);
  });

  it('hands ASP.NET Core 8’s start the shell’s component state', async () => {
    const { fetcher, sent } = app({ polls: [answered()] });
    await expect(lookup(fetcher, { componentState: true })).resolves.toBe('found');
    expect(sent[0]).toEqual([1, {}, '0', 'StartCircuit', [APP, PAGE, COMPONENTS, 'U3ludGhldGljU3RhdGU=']]);
  });

  it('gives the answer a sentence that needs the start once the server has started the page', async () => {
    const { fetcher, requests } = app({ polls: [join(attach(), render(2, pageBatch('<p>Unknown number</p>'))), started()] });
    await expect(lookup(fetcher)).resolves.toBe('unknown');
    expect(requests.filter((request) => request === `GET ${POLL}`)).toHaveLength(4);
  });

  it('answers the page’s script calls, and follows only the moves the lookup allows', async () => {
    const moved = `${APP}track/ZZ1?again`;
    const { fetcher, sent } = app({ polls: [join(attach(), callJs(4, 'isDevice', []), callJs(5, 'Widget.focus', []), started()),
      callJs(6, 'Blazor._internal.navigationManager.navigateTo', [moved, false]), answered()] });
    await expect(lookup(fetcher, { scripts: { isDevice: false }, follows: (target) => target === moved })).resolves.toBe('found');
    expect(sent.slice(1, 5)).toEqual([
      [1, {}, null, 'EndInvokeJSFromDotNet', [4, true, '[4,true,false]']],
      [1, {}, null, 'EndInvokeJSFromDotNet', [5, true, '[5,true,null]']],
      [1, {}, null, 'OnLocationChanged', [moved, false]],
      [1, {}, null, 'EndInvokeJSFromDotNet', [6, true, '[6,true,null]']],
    ]);
    for (const follows of [undefined, () => false]) {
      const refused = app({ polls: [join(attach(), callJs(4, 'Blazor._internal.navigationManager.navigateTo', [moved, false]))] });
      await expect(lookup(refused.fetcher, { follows })).rejects.toMatchObject({ kind: 'schema', provider: 'Example',
        message: 'Example Carrier\'s tracker moved to another page' });
    }
    await expect(lookup(app({ polls: [join(attach(), invocation('JS.BeginInvokeJS', ['4', 'isDevice']))] }).fetcher))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it('tells a browser check and a refusal from a missing parcel', async () => {
    const shell = (body: string, init?: ResponseInit) => lookup(app({ shell: () => new Response(body, init) }).fetcher);
    await expect(shell('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(shell('<html><head><title>Just a moment...</title></head><body><div id="cf-turnstile"></div></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge', message: 'Example Carrier answered with a browser check' });
    await expect(shell('<html><title>Tracker</title></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(shell('', { status: 302, headers: { Location: 'https://tracker.example/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(shell('', { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('preserves a rate limit on any request', async () => {
    const limited = () => new Response('', { status: 429 });
    await expect(lookup(app({ shell: limited }).fetcher)).rejects.toMatchObject({ kind: 'rate_limited', provider: 'Example' });
    await expect(lookup(app({ negotiate: limited }).fetcher)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(app({ polls: [limited] }).fetcher)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('reads a changed or malformed connection as the carrier’s schema failure', async () => {
    const failure = (options: Partial<AppOptions>) => lookup(app(options).fetcher);
    const longPolling = [{ transport: 'LongPolling', transferFormats: ['Binary'] }];
    await expect(failure({ negotiate: () => Response.json({ connectionToken: HUB_TOKEN, availableTransports: [{ transport: 'WebSockets', transferFormats: ['Binary'] }] }) }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(failure({ negotiate: () => Response.json({ connectionToken: 'not a token', availableTransports: longPolling }) })).rejects.toMatchObject({ kind: 'schema' });
    await expect(failure({ negotiate: () => new Response('<html></html>') })).rejects.toMatchObject({ kind: 'schema' });
    await expect(failure({ polls: [join(attach(), render(2, new Uint8Array([1, 2, 3])), started())] }))
      .rejects.toMatchObject({ kind: 'schema', provider: 'Example', message: 'Example Carrier returned a malformed render batch' });
    await expect(failure({ polls: [join(attach(), render(2, pageBatch('<p>Found</p>').slice(0, -3)))] })).rejects.toMatchObject({ kind: 'schema' });
    await expect(failure({ polls: [new Uint8Array([0x05, 0x95, 0x01])] }))
      .rejects.toMatchObject({ kind: 'schema', provider: 'Example', message: 'Example Carrier returned a malformed message' });
    await expect(failure({ polls: [join(invocation('JS.AttachComponent', ['0', '0']), started())] })).rejects.toMatchObject({ kind: 'schema' });
    // A component inside itself, which the answer cannot write out.
    const looped = writeBatch({ frames: [{ type: 'component', length: 1, id: 0 }], diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }] });
    await expect(failure({ polls: [join(attach(), render(2, looped), started())] }))
      .rejects.toMatchObject({ kind: 'schema', message: 'Example Carrier returned a malformed render batch' });
  });

  it('refuses the server’s handshake error', async () => {
    const { fetcher, requests } = app({});
    fetcher.mockImplementationOnce(async () => new Response(SHELL))
      .mockImplementationOnce(async () => Response.json({ connectionToken: HUB_TOKEN, availableTransports: [{ transport: 'LongPolling', transferFormats: ['Binary'] }] }))
      .mockImplementationOnce(async () => new Response(new Uint8Array()))
      .mockImplementationOnce(async () => new Response(null))
      .mockImplementationOnce(async () => new Response('{"error":"Requested protocol is not available."}\u001e'));
    await expect(lookup(fetcher)).rejects.toMatchObject({ kind: 'schema' });
    expect(requests.at(-1)).toBe(`DELETE ${POLL}`);
  });

  it('keeps the server’s own failures apart from a missing parcel', async () => {
    const failure = (polls: AppOptions['polls']) => lookup(app({ polls }).fetcher);
    await expect(failure([join(attach(), started(1, 'Circuit could not be started.'))])).rejects.toMatchObject({ kind: 'transport' });
    await expect(failure([join(attach(), started(3, null))])).rejects.toMatchObject({ kind: 'transport' });
    await expect(failure([join(attach(), started(), packMessage([7, null]))])).rejects.toMatchObject({ kind: 'transport' });
    await expect(failure([() => new Response(null, { status: 204 })])).rejects.toMatchObject({ kind: 'transport' });
    await expect(failure([join(attach(), invocation('JS.Error', ['There was an unhandled exception']))])).rejects.toMatchObject({ kind: 'indeterminate' });
    // A page that never renders an answer.
    await expect(failure([join(attach(), started())])).rejects.toMatchObject({ kind: 'indeterminate',
      message: 'Example Carrier\'s tracker did not render an answer' });
  });

  it('ends a hanging long poll with the lookup’s signal', async () => {
    let signal: AbortSignal | undefined;
    const { fetcher } = app({});
    fetcher.mockImplementationOnce(async () => new Response(SHELL))
      .mockImplementationOnce(async () => Response.json({ connectionToken: HUB_TOKEN, availableTransports: [{ transport: 'LongPolling', transferFormats: ['Binary'] }] }))
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
      }));
    const controller = new AbortController();
    const pending = lookup(fetcher, { signal: controller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    // An aborted lookup sends no goodbye.
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).not.toContain('DELETE');
  });

  it('ends a hanging long poll at the lookup’s deadline', async () => {
    const clock = fakeBudgetClock();
    const { fetcher } = app({});
    fetcher.mockImplementationOnce(async () => new Response(SHELL))
      .mockImplementationOnce(async () => Response.json({ connectionToken: HUB_TOKEN, availableTransports: [{ transport: 'LongPolling', transferFormats: ['Binary'] }] }))
      .mockImplementationOnce((_input, init) => new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }));
    const begun = Date.now();
    await clock.settle(expect(lookup(fetcher, { deadline: performance.now() + 80 })).rejects.toThrow());
    // A busy runner can spend the budget before the long poll starts; a long poll that did start was aborted.
    expect(fetcher.mock.calls[2]?.[1]?.signal?.aborted ?? true).toBe(true);
    expect(Date.now() - begun).toBeLessThan(2_000);
  });
});
