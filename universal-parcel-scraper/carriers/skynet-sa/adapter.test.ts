import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { blazorApp, callJs, HUB_TOKEN, htmlFrames, invocation, join, render, started, writeBatch, type AppOptions } from '../../core/testing/blazor.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SKYNET_SA_HUB, SKYNET_SA_TRACKER, SkynetSaTracker, skynetSaPageUrl } from './adapter.js';
import { normalizeSkynetSaNumber, parseSkynetSa } from './parser.js';
import { skynetSaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'ZZ0000000001';
const IN_TRANSIT = 'ZZ0000000002';
const REFERENCE = 'ZZ0000000003';
const LISTED = 'ZZ0000000004';
const UNKNOWN = 'ZZ0000000009';
const POLL = `${SKYNET_SA_HUB}?id=${HUB_TOKEN}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

/**
 * The app's two roots: the layout, holding the page's component with its
 * render mode, which renders the fragment in a region; and the head, which
 * renders the title.
 */
function pageBatch(html: string): Uint8Array {
  const page = htmlFrames(html);
  return writeBatch({
    frames: [
      { type: 'element', name: 'div', length: 6 }, { type: 'attribute', name: 'class', value: 'container-fluid' }, { type: 'capture' },
      { type: 'raw', code: 10 },
      { type: 'component', length: 2, id: 1 }, { type: 'raw', code: 9 },
      { type: 'region', length: page.length + 1 }, ...page,
      { type: 'element', name: 'title', length: 2 }, { type: 'text', text: 'SkyTrack' },
    ],
    diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] }, { componentId: 1, edits: [{ type: 1, sibling: 0, reference: 6 }] },
      { componentId: 3, edits: [{ type: 1, sibling: 0, reference: 7 + page.length }] }],
  });
}

const attach = () => join(invocation('JS.AttachComponent', [0, '0']), invocation('JS.AttachComponent', [3, '1']));
const shipment = (page: string) => join(attach(), render(2, pageBatch(fixture(page))), started());

/** SkyTrack: the page's shell, the hub's negotiation, a queue of long-poll answers and the messages the adapter sends. */
const hub = ({ shell = () => new Response(fixture('shell.html'), { headers: { 'Content-Type': 'text/html' } }), ...options }: AppOptions) =>
  blazorApp({ app: SKYNET_SA_TRACKER, page: `${SKYNET_SA_TRACKER}T?R=`, shell, ...options });

describe('SkyNet South Africa HTTP adapter', () => {
  it('opens the tracking page’s circuit over long polling, through the supplied transport, and closes it', async () => {
    const { fetcher, requests, sent, texts } = hub({ polls: [shipment('delivered.html')] });
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SkynetSaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' zz00 0000 0001 '))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    const page = `${SKYNET_SA_TRACKER}T?R=${DELIVERED}`;
    expect(requests).toEqual([`GET ${page}`, `POST ${SKYNET_SA_HUB}/negotiate?negotiateVersion=1`, `GET ${POLL}`, `POST ${POLL}`,
      `GET ${POLL}`, `POST ${POLL}`, `GET ${POLL}`, `POST ${POLL}`, `DELETE ${POLL}`]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    // The negotiation posts an empty body, as the server asks for a length.
    expect(fetcher.mock.calls[1]![1]!.body).toBe('');
    expect(texts).toEqual(['{"protocol":"blazorpack","version":1}\u001e']);
    // ASP.NET Core 8's start takes both components without their keys, and the shell's component state.
    expect(sent).toEqual([
      [1, {}, '0', 'StartCircuit', [SKYNET_SA_TRACKER, page, '[{"type":"server","sequence":0,"descriptor":"U3ludGhldGljRGVzY3JpcHRvcg+AA=="},'
        + '{"type":"server","sequence":1,"descriptor":"U3ludGhldGljSGVhZA/BB=="}]', 'U3ludGhldGljU3RhdGU=']],
      [1, {}, null, 'OnRenderCompleted', [2, null]],
    ]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'skynet-sa', step: 'direct', outcome: 'ok' }));
    expect(skynetSaPageUrl(DELIVERED)).toBe(page);
  });

  it('keeps each scan’s wall clock, newest first, and lets the delivery outrank the records filed after it', async () => {
    const { fetcher } = hub({ polls: [shipment('delivered.html')] });
    const result = await carrier(fetcher).track({ number: DELIVERED });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-04T15:20:11', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.stage ?? null, event.description, event.location ?? null])).toEqual([
      // The system's own branch is not a place.
      ['2026-03-04T15:20:11', null, 'POD image scanned', null],
      ['2026-03-04T11:02:45', null, 'POD created', 'Sampleton'],
      ['2026-03-04T11:02:45', 'delivered', 'Delivered', 'Sampleton'],
      ['2026-03-04T07:40:00', null, 'EMAIL : First time parcel out for delivery at Delivery branch', 'Sampleton'],
      ['2026-03-04T07:39:12', 'out_for_delivery', 'Out on Delivery', 'Sampleton'],
      ['2026-03-03T16:10:00', 'failed_attempt', 'Delivery Exception: Company closed', 'Sampleton'],
      // The repeated scan is kept once.
      ['2026-03-03T06:05:30', 'in_transit', 'Received In Branch Sampleton', 'Sampleton'],
      ['2026-03-02T18:00:00', 'accepted', 'Collected by courier', 'Exampleville'],
      ['2026-03-02T09:15:00', 'registered', 'Created waybill', 'Exampleville'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(result).not.toHaveProperty('history_truncated');
    // The references and the page's chrome are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE-1|REFERENCES|HostServer|SkyTrack|Contact/);
  });

  it('reads an inbound parcel’s airport, customs and dispatch scans', async () => {
    const { fetcher } = hub({ polls: [shipment('in-transit.html')] });
    const result = await carrier(fetcher).track({ number: IN_TRANSIT });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Dispatch from airport', last_update: null, last_update_local: '2026-03-07T09:00:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.description, event.stage ?? null])).toEqual([
      ['Dispatch from airport', 'in_transit'], ['Released From Customs', 'in_transit'], ['Rec cust agent', 'customs'],
      ['Scan into branch', 'in_transit'], ['Received from airline', 'in_transit'], ['In-house-client scan', 'in_transit'],
      ['Flight landed', 'in_transit'], ['Customs Duties Paid', null], ['Created waybill', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ local_time: '2026-03-07T09:00:00', location: 'Exampleville Airport', description: 'Dispatch from airport',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toContain('C0001');
  });

  it('reads the not-found line once the page has opened, not while it loads', async () => {
    const { fetcher, requests } = hub({ polls: [join(attach(), render(2, pageBatch(fixture('not-found.html')))), started()] });
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(requests.filter((request) => request === `GET ${POLL}`)).toHaveLength(4);
    expect(requests.at(-1)).toBe(`DELETE ${POLL}`);
  });

  it('renders the batches that replace the page’s empty state', async () => {
    const loading = writeBatch({ frames: [{ type: 'element', name: 'div', length: 2 }, { type: 'component', length: 1, id: 1 },
      { type: 'text', text: 'TRACKING INFORMATION' }], diffs: [{ componentId: 0, edits: [{ type: 1, sibling: 0, reference: 0 }] },
      { componentId: 1, edits: [{ type: 1, sibling: 0, reference: 2 }] }] });
    const page = htmlFrames(fixture('in-transit.html'));
    const loaded = writeBatch({ frames: [{ type: 'region', length: page.length + 1 }, ...page],
      diffs: [{ componentId: 1, edits: [{ type: 2, sibling: 0 }, { type: 1, sibling: 0, reference: 0 }] }] });
    const { fetcher, sent } = hub({ polls: [join(attach(), render(2, loading), started()), render(3, loaded)] });
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(sent.slice(1)).toEqual([[1, {}, null, 'OnRenderCompleted', [2, null]], [1, {}, null, 'OnRenderCompleted', [3, null]]]);
  });

  it('answers the page’s widget calls and refuses a move to another page', async () => {
    const { fetcher, sent } = hub({ polls: [join(attach(), callJs(4, 'import', ['./_content/DevExpress.Blazor/synthetic.js']), started()),
      join(callJs(5, 'DxBlazor.Input.loadModule', []), render(2, pageBatch(fixture('delivered.html'))))] });
    await expect(carrier(fetcher).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(sent.slice(1)).toEqual([
      [1, {}, null, 'EndInvokeJSFromDotNet', [4, true, '[4,true,null]']],
      [1, {}, null, 'EndInvokeJSFromDotNet', [5, true, '[5,true,null]']],
      [1, {}, null, 'OnRenderCompleted', [2, null]],
    ]);
    const moved = hub({ polls: [join(attach(), callJs(4, 'Blazor._internal.navigationManager.navigateTo', [`${SKYNET_SA_TRACKER}`, false]))] });
    await expect(carrier(moved.fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('reads a changed tracking page or history as a schema failure', async () => {
    const lookup = (options: Partial<AppOptions>) => carrier(hub({ polls: [], ...options }).fetcher).track({ number: DELIVERED });
    await expect(lookup({ shell: () => new Response('<html><title>SkyTrack</title></html>') })).rejects.toMatchObject({ kind: 'schema' });
    // A history row without its branch.
    const changed = fixture('delivered.html').replace(/<td style="padding: 6px !important;">Exampleville<\/td>/, '');
    await expect(lookup({ polls: [join(attach(), render(2, pageBatch(changed)), started())] })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('binds the page to the requested waybill, not to another lookup or a shipment it is a reference of', async () => {
    // The answer for another number.
    await expect(carrier(hub({ polls: [shipment('delivered.html')] }).fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The number found only as other shipments' reference.
    const referenced = hub({ polls: [shipment('reference.html')] });
    await expect(carrier(referenced.fetcher).track({ number: REFERENCE })).rejects.toMatchObject({ kind: 'indeterminate' });
    // A waybill listed with another one keeps its own scans alone.
    const listed = fixture('reference.html').replace(`${REFERENCE} DETAILS:`, `${LISTED} DETAILS:`);
    const { fetcher } = hub({ polls: [join(attach(), render(2, pageBatch(listed)), started())] });
    const result = await carrier(fetcher).track({ number: LISTED });
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-03-08T12:00:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered', 'Created waybill']);
    expect(JSON.stringify(result)).not.toMatch(/INVENTED|MADEUP|ZZ0000000003|Out on Delivery/);
  });

  it('asks nothing for a number SkyNet does not issue, and offers no recognition', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ZZ001', 'ZZ00000000000000000001', 'ZZZZZZZZ', 'ZZ/0001', `ZZ${'0'.repeat(80)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(carrier(fetcher).recognize).toBeUndefined();
    expect(normalizeSkynetSaNumber(' zz-0000 0000.01 ')).toBe(DELIVERED);
  });

  it('routes a number filed under SkyNet South Africa to the adapter, and claims none by shape', async () => {
    const { fetcher } = hub({ polls: [shipment('delivered.html')] });
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'skynet-sa' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'skynet-sa', source: 'skynet-sa', result: { current_stage: 'delivered' } });
    for (const number of [DELIVERED, '000000000001', 'R000000000001']) expect(detectCarrierMatch(number).carrier, number).not.toBe('skynet-sa');
  });
});

describe('SkyNet South Africa page', () => {
  const page = (change: (html: string) => string = (html) => html, name = 'delivered.html') => change(fixture(name));

  it('falls back to the shared wording rules and marks a long history as truncated', () => {
    const rows = Array.from({ length: 101 }, (_, index) => `<tr><td>01/03/2026</td><td>12:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}</td>`
      + '<td>Scan into branch</td><td>Sampleton</td></tr>').join('');
    const long = parseSkynetSa(page((html) => html.replace(/(<tbody>)[\s\S]*(<\/tbody>)/, `$1${rows}$2`)), DELIVERED);
    expect(long).toMatchObject({ current_stage: 'in_transit', history_truncated: true });
    expect(long.events).toHaveLength(100);
    const worded = parseSkynetSa(page((html) => html.replace('POD image scanned', 'Parcel out for delivery')), DELIVERED);
    expect(worded.events![0]).toMatchObject({ description: 'Parcel out for delivery', stage: 'out_for_delivery' });
    expect(worded).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Parcel out for delivery' });
    const unworded = parseSkynetSa(page((html) => html.replace('POD image scanned', 'Synthetic note')), DELIVERED);
    expect(unworded.events![0]).not.toHaveProperty('stage');
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const row = (time: string, description: string) => `<tr><td>01/03/2026</td><td>${time}</td><td>${description}</td><td>Sampleton</td></tr>`;
    const listed = parseSkynetSa(page((html) => html.replace(/(<tbody>)[\s\S]*(<\/tbody>)/,
      `$1${row('09:00:00', 'Created waybill')}${row('12:00:00', 'Scan into branch')}${row('12:00:00', 'Parcel out for delivery')}$2`)), DELIVERED);
    expect(listed.events!.map((event) => event.description)).toEqual(['Parcel out for delivery', 'Scan into branch', 'Created waybill']);
  });

  it('keeps a waybill listed twice with the same scans, and refuses one listed with different scans', () => {
    const block = (html: string) => /<hr[\s\S]*<\/table>\s*<\/div>\n/.exec(html)![0];
    const twice = page((html) => html.replace(block(html), block(html) + block(html)));
    expect(parseSkynetSa(twice, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    const differing = page((html) => html.replace(block(html), block(html) + block(html).replace('Created waybill', 'Scan into branch')));
    expect(() => parseSkynetSa(differing, DELIVERED)).toThrow(/twice with different scans/);
  });

  it('rejects a page it cannot read for certain', () => {
    expect(() => parseSkynetSa(page((html) => html.replace('04/03/2026', '31/02/2026')), DELIVERED)).toThrow(/invalid scan time/);
    expect(() => parseSkynetSa(page((html) => html.replace('07:39:12', '07:39')), DELIVERED)).toThrow(/invalid scan time/);
    expect(() => parseSkynetSa(page((html) => html.replace('</table>', '</table><table></table>')), DELIVERED)).toThrow(/more than one history/);
    expect(() => parseSkynetSa(page((html) => html.replace('>Branch<', '>Depot<')), DELIVERED)).toThrow(/changed history/);
    expect(() => parseSkynetSa(page((html) => html.replace(/WAYBILL NUMBER: \w+/, 'WAYBILL')), DELIVERED)).toThrow(/without their waybill/);
    expect(() => parseSkynetSa(page((html) => html.replace(/<hr[\s\S]*<\/div>\n(?=\s*<\/div>\s*<div)/, '')), DELIVERED)).toThrow(/without a waybill/);
    expect(() => parseSkynetSa(page((html) => html.replace('</i> Delivered<', '</i> <')), DELIVERED)).toThrow(/without wording/);
    expect(() => parseSkynetSa(page((html) => html.replace(`${DELIVERED} DETAILS:`, 'DETAILS')), DELIVERED)).toThrow(/without an answer/);
    expect(() => parseSkynetSa(page((html) => html.replace(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>')), DELIVERED)).toThrow(NoHistoryError);
    expect(() => parseSkynetSa(page((html) => html.replace(/<div class="row"[\s\S]*<\/table>\s*<\/div>/, '')), DELIVERED)).toThrow(NoHistoryError);
  });
});

describe('SkyNet South Africa status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string; unmapped?: boolean }[]) {
      const answer = statusMapAnswer({ carrier: 'skynet-sa', providerCode: null, description: entry.wording });
      if (entry.unmapped) {
        expect(skynetSaStage(entry.wording), entry.wording).toBeNull();
        expect(answer, entry.wording).toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(skynetSaStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMapAnswer({ carrier: 'skynet-sa', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
