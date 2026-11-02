import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { blazorApp, callJs, HUB_TOKEN, htmlFrames, invocation, join, render, started, writeBatch, type AppOptions } from '../../core/testing/blazor.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TRANSAHER_HUB, TRANSAHER_TRACKER, TransaherTracker, transaherPageUrl } from './adapter.js';
import { normalizeTransaherNumber, parseTransaher } from './parser.js';
import { transaherStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '103011090070012345000000001';
const IN_TRANSIT = '103011090070012346000000002';
const UNKNOWN = '103000000000000000000000003';
const POLL = `${TRANSAHER_HUB}?id=${HUB_TOKEN}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/** A root component holding the page's component, which renders the fragment in a region. */
function pageBatch(html: string): Uint8Array {
  const page = htmlFrames(html);
  return writeBatch({
    frames: [
      { type: 'element', name: 'div', length: 4 }, { type: 'attribute', name: 'class', value: 'rz-layout' }, { type: 'capture' },
      { type: 'component', length: 1, id: 1 },
      { type: 'region', length: page.length + 1 }, ...page,
    ],
    diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }, { componentId: 1, edits: [{ type: 1, sibling: 0, reference: 4 }] }],
  });
}

const attach = () => invocation('JS.AttachComponent', [0, 'app']);
const shipment = (page: string) => join(attach(), render(2, pageBatch(fixture(page))), started());

/** The tracker's app: the page's shell, the hub's negotiation, a queue of long-poll answers and the messages the adapter sends. */
const hub = ({ shell = () => new Response(fixture('shell.html'), { headers: { 'Content-Type': 'text/html' } }), ...options }: AppOptions) =>
  blazorApp({ app: TRANSAHER_TRACKER, page: `${TRANSAHER_TRACKER}tracking/`, shell, ...options });

describe('Transaher HTTP adapter', () => {
  it('opens the tracking page’s circuit over long polling, through the supplied transport, and closes it', async () => {
    const { fetcher, requests, sent, texts } = hub({ polls: [shipment('delivered.html')] });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TransaherTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${DELIVERED.slice(0, 9)} ${DELIVERED.slice(9)} `))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    const page = `${TRANSAHER_TRACKER}tracking/-5,0,${DELIVERED}`;
    expect(requests).toEqual([`GET ${page}`, `POST ${TRANSAHER_HUB}/negotiate?negotiateVersion=1`, `GET ${POLL}`, `POST ${POLL}`,
      `GET ${POLL}`, `POST ${POLL}`, `GET ${POLL}`, `POST ${POLL}`, `DELETE ${POLL}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    // The negotiation posts an empty body, as the server asks for a length.
    expect(fetcher.mock.calls[1]![1]!.body).toBe('');
    expect(texts).toEqual(['{"protocol":"blazorpack","version":1}\u001e']);
    expect(sent).toEqual([
      [1, {}, '0', 'StartCircuit', [TRANSAHER_TRACKER, page, '[{"type":"server","sequence":0,"descriptor":"U3ludGhldGljRGVzY3JpcHRvcg+AA=="}]']],
      [1, {}, null, 'OnRenderCompleted', [2, null]],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'transaher', step: 'direct', outcome: 'ok' }));
    expect(transaherPageUrl(DELIVERED)).toBe(page);
  });

  it('keeps each situation’s wall clock, newest first, and lets the summary’s delivery decide', async () => {
    const { fetcher } = hub({ polls: [shipment('delivered.html')] });
    const result = await carrier(fetcher).track({ number: DELIVERED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: null, last_update_local: '2026-03-04T12:30:05', expected_delivery: null,
      sender_name: 'TIENDA DE EJEMPLO, S.L.' });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description])).toEqual([
      // The van's row is filed after the delivery it led to.
      ['2026-03-04T12:30:05', 'out_for_delivery', 'EN REPARTO'],
      ['2026-03-04T11:02:45', 'delivered', 'ENTREGADO'],
      ['2026-03-03T07:15:00', null, 'PEDIR DIA Y HORA DESCARGA'],
      // The repeated departure is kept once.
      ['2026-03-02T22:41:30', 'in_transit', 'SALIDA DE ORIGEN'],
      ['2026-03-02T14:20:00', 'registered', 'REGISTRADO'],
      ['2026-03-02T08:05:12', 'in_transit', 'SALIDA DE ORIGEN'],
    ]);
    expect(result.events!.every((event) => event.time === undefined && event.location === undefined)).toBe(true);
    expect(result).not.toHaveProperty('summary_only');
    expect(result).not.toHaveProperty('history_truncated');
    // The recipient, the reference, the shipping day and the proof of delivery are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Lucía|PEDIDO|02-03-2026|Conforme|090-70012345/);
  });

  it('goes as far as the history when the summary’s status lags it', async () => {
    const { fetcher } = hub({ polls: [shipment('in-transit.html')] });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toEqual({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'SALIDA DE ORIGEN', last_update: null, last_update_local: '2026-03-05T23:10:20',
      expected_delivery: null, sender_name: 'ALMACENES SINTÉTICOS, S.A.', events: [
        { local_time: '2026-03-05T23:10:20', description: 'SALIDA DE ORIGEN', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-05T16:45:00', description: 'REGISTRADO', stage: 'registered', stage_source: 'carrier_map' },
      ] });
  });

  it('reads the unknown-number sentence once the page has opened, not while it loads', async () => {
    const { fetcher, requests } = hub({ polls: [join(attach(), render(2, pageBatch(fixture('not-found.html')))), started()] });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(requests.filter((request) => request === `GET ${POLL}`)).toHaveLength(4);
    expect(requests.at(-1)).toBe(`DELETE ${POLL}`);
  });

  it('renders the batches that replace the page’s loading state', async () => {
    const loading = writeBatch({ frames: [{ type: 'element', name: 'div', length: 2 }, { type: 'component', length: 1, id: 1 },
      { type: 'text', text: 'Cargando...' }], diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] },
      { componentId: 1, edits: [{ type: 1, sibling: 0, reference: 2 }] }] });
    const page = htmlFrames(fixture('in-transit.html'));
    const loaded = writeBatch({ frames: [{ type: 'region', length: page.length + 1 }, ...page],
      diffs: [{ componentId: 1, edits: [{ type: 2, sibling: 0 }, { type: 1, sibling: 0, reference: 0 }] }] });
    const { fetcher, sent } = hub({ polls: [join(attach(), render(2, loading), started()), render(3, loaded)] });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(sent.slice(1)).toEqual([[1, {}, null, 'OnRenderCompleted', [2, null]], [1, {}, null, 'OnRenderCompleted', [3, null]]]);
  });

  it('answers the page’s device check and follows its move to its own tracking route', async () => {
    const page = `${TRANSAHER_TRACKER}tracking/-5,0,${DELIVERED}`;
    const { fetcher, sent } = hub({ polls: [join(attach(), callJs(4, 'isDevice', []), started()),
      callJs(5, 'Blazor._internal.navigationManager.navigateTo', [page, false, false]), shipment('delivered.html')] });
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(sent.slice(1, 4)).toEqual([
      [1, {}, null, 'EndInvokeJSFromDotNet', [4, true, '[4,true,false]']],
      [1, {}, null, 'OnLocationChanged', [page, false]],
      [1, {}, null, 'EndInvokeJSFromDotNet', [5, true, '[5,true,null]']],
    ]);
  });

  it('refuses a move to another page or another number', async () => {
    for (const target of ['https://transaher.es/', `${TRANSAHER_TRACKER}tracking/-5,0,${IN_TRANSIT}`, `${TRANSAHER_TRACKER}login`]) {
      const { fetcher } = hub({ polls: [join(attach(), callJs(4, 'Blazor._internal.navigationManager.navigateTo', [target, false]))] });
      await expect(carrier(fetcher).track({ number: DELIVERED }), target).rejects.toMatchObject({ kind: 'schema' });
    }
  });

  it('reads a changed tracking page or grid as a schema failure', async () => {
    const lookup = (options: Partial<AppOptions>) => carrier(hub({ polls: [], ...options }).fetcher).track({ number: DELIVERED });
    await expect(lookup({ shell: () => new Response('<html><title>WEBCLIENT</title></html>') })).rejects.toMatchObject({ kind: 'schema' });
    // The page's grid without its rows' three cells.
    const changed = fixture('delivered.html').replace(/<td rowspan="1" colspan="1"><span class="rz-cell-data" title="">ENTREGADO<\/span><\/td>/, '');
    await expect(lookup({ polls: [join(attach(), render(2, pageBatch(changed)), started())] })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the page to the requested number through its expedition number', async () => {
    const { fetcher } = hub({ polls: [shipment('delivered.html')] });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('recognizes a known number and the unknown-number answer, and asks nothing for a number Transaher does not issue', async () => {
    const known = hub({ polls: [shipment('in-transit.html')] });
    await expect(carrier(known.fetcher).recognize!(IN_TRANSIT)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-05T23:10:20' });
    const unknown = hub({ polls: [join(attach(), render(2, pageBatch(fixture('not-found.html'))), started())] });
    await expect(carrier(unknown.fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(hub({ polls: [() => new Response('', { status: 429 })] }).fetcher).recognize!(DELIVERED)).rejects.toMatchObject({ kind: 'rate_limited' });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('1030110900700123450000000')).resolves.toEqual({ known: false });
    for (const number of ['203011090070012345000000001', '1030110900700123450000000011', 'SAMPLE103', `103${'0'.repeat(80)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTransaherNumber(' 1030-1109 0070 0123 4500 0000 001 ')).toBe(DELIVERED);
  });

  it('routes a number filed under Transaher, or detected as one of its numbers, to the adapter', async () => {
    const { fetcher } = hub({ polls: [shipment('delivered.html')] });
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'transaher' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'transaher', source: 'transaher', result: { current_stage: 'delivered' } });
    const detected = hub({ polls: [shipment('delivered.html')] });
    await expect(createTracker({ fetcher: detected.fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'transaher', source: 'transaher' });
  });
});

describe('Transaher page', () => {
  const page = (change: (html: string) => string = (html) => html) => `<div class="rz-layout">${change(fixture('delivered.html'))}</div>`;

  it('marks a paged history as truncated, since the grid opens on its oldest page', () => {
    const paged = page((html) => html.replace('</table>', '</table><div class="rz-paginator rz-unselectable-text"><a class="rz-paginator-next">2</a></div>'));
    expect(parseTransaher(paged, DELIVERED)).toMatchObject({ current_stage: 'delivered', history_truncated: true });
  });

  it('keeps the summary alone when the grid has no rows, and drops a masked sender', () => {
    const empty = page((html) => html.replace(/<tbody>[\s\S]*<\/tbody>/,
      '<tbody><tr class="rz-datatable-emptymessage-row"><td class="rz-datatable-emptymessage" colspan="3"><span>No records to display.</span></td></tr></tbody>')
      .replace('TIENDA DE EJEMPLO, S.L.', 'TIE*** DE EJ*****'));
    const result = parseTransaher(empty, DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregado', summary_only: true, events: [] });
    expect(result).not.toHaveProperty('sender_name');
    expect(result).not.toHaveProperty('last_update_local');
  });

  it('rejects a page it cannot read for certain', () => {
    expect(() => parseTransaher(page((html) => html.replace('04/03/2026', '31/02/2026')), DELIVERED)).toThrow(/invalid scan time/);
    expect(() => parseTransaher(page((html) => html.replace('11:02:45', '11:02')), DELIVERED)).toThrow(/invalid scan time/);
    expect(() => parseTransaher(page((html) => html + html), DELIVERED)).toThrow(/more than one history|repeated summary/);
    expect(() => parseTransaher(page((html) => html.replace('090-70012345', '')), DELIVERED)).toThrow(/without its shipment/);
    expect(() => parseTransaher(page((html) => html.replace('090-70012345', 'Consultar')), DELIVERED)).toThrow(/another shipment/);
    expect(() => parseTransaher(page((html) => html.replace(/>(?:REGISTRADO|SALIDA DE ORIGEN|PEDIR DIA Y HORA DESCARGA|ENTREGADO|EN REPARTO)</g, '><')), DELIVERED))
      .toThrow(/without wording/);
    expect(() => parseTransaher(page((html) => html.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>').replace('Entregado', '')), DELIVERED))
      .toThrow(NoHistoryError);
  });
});

describe('Transaher numbers', () => {
  it('detects whole 27-digit numbers starting 103 only', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'transaher', confidence: 'high' });
    }
    for (const number of ['10301109007001234500000000', '1030110900700123450000000012', '203011090070012345000000001']) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('transaher');
    }
  });
});

describe('Transaher status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      const answer = statusMapAnswer({ carrier: 'transaher', providerCode: null, description: entry.wording });
      if (entry.unmapped) {
        expect(transaherStage(entry.wording), entry.wording).toBeNull();
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(transaherStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'transaher', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
