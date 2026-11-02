import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, fmxTrackingUrl } from './adapter.js';
import { normalizeFmxNumber, parseFmx } from './parser.js';
import { fmxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'MYX0000000017';
const UNKNOWN = 'MYX0000000099';
const STATION = 'TSTG, eFMX Test Gateway';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const replying = (response: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => response());
const destroyed = () => text('destroyed.html');
/** A timeline row as the tracker renders it. */
const row = (clock: string, wording: string, station = STATION) => `
										<div class="time-label">
											<span class="time-line-c-font bg-them">${clock}</span>
										</div>
										<div>
											<i class="fas fa-truck bg-them"></i>
											<?$class?>
											<div class="timeline-item">
													<h3 class="timeline-header time-line-c2-font"><a class="text-them">${wording}</a></h3>
													<div class="timeline-body time-line-c-font">
														${station}													</div>
											</div>
										</div>`;
/** The fixture with rows put above its newest row. */
const withRows = (...rows: string[]) => destroyed().replace('<div class="timeline">', `<div class="timeline">${rows.join('')}`);
/** The fixture with its history replaced. */
const withHistory = (...rows: string[]) => {
  const $ = load(destroyed());
  $('div.timeline').html(rows.join(''));
  return $.html();
};

describe('FMX numbers', () => {
  it('takes MYX and ten digits, and is offered for them', () => {
    expect(normalizeFmxNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const other of ['MYX000000001', 'MYX00000000170', 'MYC000000017', 'MY0000000017', '0000000017']) {
      expect(() => normalizeFmxNumber(other), other).toThrow('MYX and ten digits');
    }
    expect(detectCarrierMatch(NUMBER).candidates).toContain('fmx');
    expect(recognitionCandidates(NUMBER).map(({ carrier: id }) => id)).toContain('fmx');
  });

  it('reads a link to the result page, in English and Chinese', () => {
    for (const link of [`https://www.fmx.asia/result_detail.php?p=1&conno=${NUMBER}`, `https://fmx.asia/cn/result_detail.php?p=1&conno=${NUMBER}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'fmx' });
    }
  });
});

describe('FMX tracking', () => {
  it('asks the result page for the one number', async () => {
    const fetcher = replying(() => html(destroyed()));
    await carrier(fetcher).track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(`https://www.fmx.asia/result_detail.php?p=1&conno=${NUMBER}`);
    expect(fmxTrackingUrl(NUMBER)).toBe(fetcher.mock.calls[0]![0]);
  });

  it('reads the scans newest first, on wall clocks with no zone, without the card’s details', () => {
    const result = parseFmx(destroyed(), NUMBER);
    expect(result).toEqual({
      status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map', last_status_text: 'Shipment Destroyed',
      last_update: null, last_update_local: '2026-03-09T11:30:00', expected_delivery: null,
      events: [
        { local_time: '2026-03-09T11:30:00', location: STATION, description: 'Shipment Destroyed', stage: 'exception', stage_source: 'carrier_map' },
        { local_time: '2026-02-02T17:45:10', location: STATION, description: 'Parcel returned to shipper', stage: 'returned', stage_source: 'carrier_map' },
        { local_time: '2026-01-26T21:05:00', location: STATION, description: `Customs clearance in progress at ${STATION}`,
          stage: 'customs', stage_source: 'carrier_map' },
      ],
    });
    // The destination, the references and the template's customer code stay out.
    expect(JSON.stringify(result)).not.toMatch(/Sampletown|SYNTHETIC-REF|A000000/);
  });

  it('drops the signatory and the delivery date, and stages a wording the map does not list by the shared rules or not at all', () => {
    const page = withRows(row('2026-03-10 09:00:00', 'Synthetic note'), row('2026-03-10 08:00:00', 'Delivered'))
      .replace(/(Signatory:<\/small> <\/p>\s*<h6 class="des_1">)\s*/, '$1SYNTHETIC SIGNER')
      .replace(/(Delivery Date:<\/small> <\/p>\s*<span class="des_1">)/, '$12026-03-10 08:00:00');
    const result = parseFmx(page, NUMBER);
    expect(result.events!.slice(0, 2)).toEqual([
      { local_time: '2026-03-10T09:00:00', location: STATION, description: 'Synthetic note' },
      { local_time: '2026-03-10T08:00:00', location: STATION, description: 'Delivered', stage: 'delivered', stage_source: 'wording:language' },
    ]);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      last_status_text: 'Synthetic note', last_update_local: '2026-03-10T09:00:00' });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC SIGNER');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps scans of one second in the tracker’s order, and a row without a station without a place', () => {
    const result = parseFmx(withHistory(row('2026-03-10 09:00:00', 'Synthetic second'), row('2026-03-10 09:00:00', 'Synthetic first', '')), NUMBER);
    expect(result.events).toEqual([
      { local_time: '2026-03-10T09:00:00', location: STATION, description: 'Synthetic second' },
      { local_time: '2026-03-10T09:00:00', description: 'Synthetic first' },
    ]);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic second' });
    expect(result).not.toHaveProperty('current_stage');
  });

  it('reads the placeholder heading for the number asked as not found', async () => {
    const fetcher = replying(() => html(text('not-found.html')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved route, a refusal, a firewall page, a rate limit and an outage apart from a missing consignment', async () => {
    const cases: [Response, string][] = [
      [html('', { status: 302, headers: { Location: 'https://www.fmx.asia/' } }), 'transport'],
      [html('', { status: 404 }), 'transport'],
      [html('<html><title>Access Denied</title></html>', { status: 403 }), 'challenge'],
      [html('', { status: 429, headers: { 'Retry-After': '30' } }), 'rate_limited'],
      [html('', { status: 500 }), 'indeterminate'],
      [html('', { status: 503 }), 'maintenance'],
      [html('<html><head><title>Just a moment...</title></head></html>'), 'challenge'],
      [html('<html><body><h2>Server Error</h2></body></html>'), 'schema'],
      [html(''), 'schema'],
      // The not-found page names another number than the one asked.
      [html(text('not-found.html')), 'indeterminate'],
    ];
    for (const [response, kind] of cases) {
      await expect(carrier(replying(() => response.clone())).track({ number: NUMBER }), kind).rejects.toMatchObject({ kind });
    }
  });

  it('reads only the whole placeholder, for the number asked, as not found', () => {
    const missing = text('not-found.html');
    expect(() => parseFmx(missing, UNKNOWN)).toThrow('no data');
    for (const page of [
      missing.replace('* Consignment Data Generated, Awaiting for Handover', 'Consignment Data Generated'),
      missing.replace('* Consignment Data Generated, Awaiting for Handover', '* Consignment Data Generated, Awaiting for Handover. Please try again later'),
      missing.replace('<div hidden>', '<div class="timeline">'),
    ]) expect(() => parseFmx(page, UNKNOWN)).toThrow('without a consignment');
    expect(() => parseFmx(missing.replace(/<a href="[^"]*result_detail\.php[^"]*">[^<]*<\/a>/g, ''), UNKNOWN)).toThrow('unexpected page');
    expect(() => parseFmx(missing.replace(`cn/result_detail.php?p=1&conno=${UNKNOWN}`, `cn/result_detail.php?p=1&conno=${NUMBER}`), UNKNOWN))
      .toThrow('another number');
  });

  it('leaves another consignment, an empty history and a changed page open or failed, never found', () => {
    expect(() => parseFmx(destroyed().replace(`<span class="des_1">${NUMBER}</span>`, `<span class="des_1">${UNKNOWN}</span>`), NUMBER))
      .toThrow('another consignment');
    expect(() => parseFmx(destroyed().replace(`<span class="des_1">${NUMBER}</span>`, '<span class="des_1"></span>'), NUMBER)).toThrow('without its number');
    expect(() => parseFmx(withHistory(), NUMBER)).toThrow(NoHistoryError);
    expect(() => parseFmx(destroyed().replace('<div class="timeline">', '<div class="timeline-list">'), NUMBER)).toThrow('without its timeline');
    expect(() => parseFmx(destroyed().replace('<hr>', `<p><small>Tracking Number:</small></p><span class="des_1">${UNKNOWN}</span>`), NUMBER))
      .toThrow('several consignments');
    expect(() => parseFmx(destroyed().replace('Tracking Number:', 'Consignment No:'), NUMBER)).toThrow('without a consignment');
    expect(() => parseFmx(withRows('<div><div class="timeline-item"><h3 class="timeline-header">Synthetic</h3></div></div>'), NUMBER))
      .toThrow('scan without its time');
    expect(() => parseFmx(withRows('<div class="time-label"><span>2026-03-10 09:00:00</span></div>'), NUMBER)).toThrow('time without its scan');
    expect(() => parseFmx(withRows(row('2026-03-10 09:00:00', '')), NUMBER)).toThrow('without wording');
    for (const clock of ['2026-02-30 10:00:00', '2026-03-10 24:00:00', '10/03/2026 09:00', '2026-03-10', '']) {
      expect(() => parseFmx(withRows(row(clock, 'Synthetic')), NUMBER), clock).toThrow('invalid scan time');
    }
  });

  it('recognizes a number its tracker holds, and not one it has no data for', async () => {
    await expect(carrier(replying(() => html(destroyed()))).recognize!(NUMBER))
      .resolves.toMatchObject({ known: true, lastActivityLocal: '2026-03-09T11:30:00' });
    await expect(carrier(replying(() => html(text('not-found.html')))).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const fetcher = replying(() => html(destroyed()));
    await expect(carrier(fetcher).recognize!('MYX123')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('FMX status map', () => {
  it('stages every wording it lists, with the station the tracker fills in, and the app reads it', () => {
    const wordings = statuses.entries.map((entry) => entry.wording.replace('…', STATION));
    for (const [at, wording] of wordings.entries()) {
      const { stage } = statuses.entries[at]!;
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(fmxStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, normalizeStatusWording('Customs clearance in progress at'))).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'fmx', providerCode: null, description: `Customs clearance in progress at ${STATION}` }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    expect(statusMapAnswer({ carrier: 'fmx', providerCode: null, description: 'Synthetic note' })).toEqual({ kind: 'unknown' });
  });
});
