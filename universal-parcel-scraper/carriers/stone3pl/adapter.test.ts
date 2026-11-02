import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { recognitionCandidates } from '../../core/recognition/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, STONE3PL_API, Stone3plTracker } from './adapter.js';
import { normalizeStone3plNumber, parseStone3pl, stone3plWording } from './parser.js';
import { stone3plStage } from './status.js';

const NUMBER = 'S900000000000000001';
const MISSING = 'S900000000000000002';
type Row = Record<string, unknown>;
type Reply = { code: number; data: { all_data: Row[] } };
const fixture = (name = 'transit') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const changed = (change: (row: Row) => void) => { const value = fixture(); change(value.data.all_data[0]!); return value; };
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Stone3PL', () => {
  it('keeps origin scans, milestones and onward number without inventing a timezone or ETA', () => {
    const result = parseStone3pl(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'facility - Outbound',
      last_update: null, last_update_local: '2030-01-20T07:36:46', expected_delivery: null,
      destination_country: 'AU', origin_country: 'CN', service_name: 'STONE3PL.COM', delivery_tracking_number: 'EJR900000001AU' });
    expect(result.events).toHaveLength(5);
    expect(result.events!.map(event => event.stage)).toEqual(['in_transit', 'registered', 'accepted', 'registered', 'registered']);
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('keeps destination and origin scans, including the explicit partner, without a signer', () => {
    const result = parseStone3pl(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivery_carrier: 'australia-post' });
    expect(result.events).toHaveLength(7);
    expect(result.events![0]).toMatchObject({ description: 'Delivered', stage: 'delivered', local_time: '2030-01-22T12:30:00' });
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
  });

  it('uses no-information front_status rather than raw status 1 or lookup-time dates', async () => {
    const value = fixture('not-found');
    expect(() => parseStone3pl(value, MISSING)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(value))).recognize!(MISSING)).resolves.toEqual({ known: false });
    const pending = structuredClone(value); pending.data.all_data[0]!.front_status = 1;
    expect(() => parseStone3pl(pending, MISSING)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('binds the entire identifier and refuses unrelated, ambiguous or truncated matches', () => {
    expect(() => parseStone3pl(fixture(), MISSING)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const duplicate = fixture(); duplicate.data.all_data.push(duplicate.data.all_data[0]!);
    expect(() => parseStone3pl(duplicate, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStone3pl(changed(row => { row.number = NUMBER + '9'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStone3pl(changed(row => { row.number = { value: NUMBER }; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseStone3pl(fixture(), 'EJR900000001AU').canonical_tracking_number).toBe(NUMBER);
  });

  it.each(['2030-02-30 07:36:46', '2030-01-20 24:00:00', '2030-01-20 07:60:00', 'yesterday'])('refuses malformed scan time %s', time => {
    const value = changed(row => { (row.track_info as Row[])[0]!.t_time = time; });
    expect(() => parseStone3pl(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses incomplete histories and does not turn service errors into not-found', () => {
    for (const change of [(row: Row) => { row.track_info = {}; }, (row: Row) => { (row.track_info as Row[])[0]!.text = []; },
      (row: Row) => { row.track_last = [{ t_time: '2030-01-22 08:00:00' }]; }]) {
      expect(() => parseStone3pl(changed(change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseStone3pl({ code: 1, data: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStone3pl({ code: 0, data: { all_data: [] } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('deduplicates exact relays and marks a delivery headline without its scan as partial', () => {
    const value = changed(row => { row.track_last = [(row.track_info as Row[])[0]!]; row.front_status = 3; });
    const result = parseStone3pl(value, NUMBER);
    expect(result.events).toHaveLength(5);
    expect(result).toMatchObject({ current_stage: 'delivered', summary_only: true, last_update: null });
  });

  it('keeps the page\'s pick-up bucket over a scan worded as transit', () => {
    const value = changed(row => { row.front_status = 2; });
    expect(parseStone3pl(value, NUMBER)).toMatchObject({ current_stage: 'ready_for_pickup', summary_only: true });
    delete value.data.all_data[0]!.front_status; value.data.all_data[0]!.status = 25;
    expect(parseStone3pl(value, NUMBER)).toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('does not turn destination milestone objects into scans or discard the origin history', () => {
    const value = changed(row => { row.track_last = { '-1': { t_time: '2030-01-21 04:54:49' }, '0': { t_time: '' } }; });
    expect(parseStone3pl(value, NUMBER)).toMatchObject({ events: expect.any(Array), last_update_local: '2030-01-20T07:36:46' });
    expect(parseStone3pl(value, NUMBER).events).toHaveLength(5);
  });

  it('uses the injected transport, User-Agent, form encoding and lookup budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await new Stone3plTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER, { budgetMs: 1000.5 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(STONE3PL_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ 'data[0][number]': NUMBER, 'data[0][i]': '0' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'stone3pl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it.each([404, 405, 410, 302, 429])('preserves HTTP %s as a failure without retrying a response', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(new Stone3plTracker({ fetcher }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a blocked HTML reply from a missing parcel', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<title>Just a moment</title><div>cf-turnstile</div>'));
    await expect(new Stone3plTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('makes a low-confidence suggestion and parses official tracking links', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', candidates: expect.arrayContaining(['stone3pl']) });
    expect(parseTrackingInput(`https://stone3pl.com/?route=services/track&nums=${NUMBER}`)).toMatchObject({ trackingNumber: NUMBER, carrier: 'stone3pl' });
    expect(normalizeStone3plNumber(' s900 000000000000001 ')).toBe(NUMBER);
    expect(() => normalizeStone3plNumber('S123&other=1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(stone3plWording('Delivered, signed by Synthetic Recipient')).toBe('Delivered');
    expect(stone3plWording('Call +61 400 000 000')).not.toContain('400');
    expect(statusMapAnswer({ carrier: 'stone3pl', providerCode: '1', description: 'Pickup Scan' })).toMatchObject({ kind: 'mapped', stage: 'accepted' });
  });

  it("moves the parcel on through the ports, both clearances and the hand-over to the last-mile carrier", () => {
    expect(['Arrived at domestic terminal station', 'Port of departure', 'International shipment release - Export', 'Port of departure - Departure',
      'Port of destination - Arrival', 'International shipment release - Import', 'Pick up by local carrier at destination port',
      'Batch delivery to carrier'].map(stone3plStage)).toEqual(Array(8).fill('in_transit'));
  });

  it('works through the public tracker with universal providers disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture()));
    const answer = await createTracker({ providers: [], fetcher }).track({ number: NUMBER, carrier: 'stone3pl' });
    expect(answer).toMatchObject({ carrier: 'stone3pl', source: 'stone3pl', result: { current_stage: 'in_transit', events: expect.any(Array) } });
    expect(answer.result.events).toHaveLength(5);
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(fixture()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('confirms a suggested shape before automatic tracking and excludes generic partner numbers from preflight', async () => {
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('stone3pl');
    expect(recognitionCandidates('EJR900000001AU').map(candidate => candidate.carrier)).not.toContain('stone3pl');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture()));
    const answer = await createTracker({ providers: [], fetcher }).track({ number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'stone3pl', source: 'stone3pl' });
    expect(answer.result.events).toHaveLength(5);
  });

  it('does not start a request when the caller has cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController(); controller.abort();
    await expect(new Stone3plTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
