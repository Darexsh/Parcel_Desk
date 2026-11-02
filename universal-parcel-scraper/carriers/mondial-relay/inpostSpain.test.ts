import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, InputRequiredError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { createTracker } from '../../facade/index.js';
import { MondialRelayTracker, mondialRelayTrackingUrl } from './adapter.js';
import { parseInpostSpainPage } from './inpostSpain.js';

// Every number, label and instant here is synthetic.
const NUMBER = 'FV00000001';
const PAGE_URL = `https://www.inpost.es/seguimiento-del-envio/?parcelNumber=${NUMBER}`;
const FIXTURE = readFileSync(new URL('./fixtures/inpost-es-awaiting-collection.html', import.meta.url), 'utf8');

/** Astro's serialized form of a prop value. */
function pair(value: unknown): unknown {
  if (Array.isArray(value)) return [1, value.map(pair)];
  if (value && typeof value === 'object') return [0, Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pair(item)]))];
  return value === undefined ? [0] : [0, value];
}

function page(props: Record<string, unknown>): string {
  const serialized = JSON.stringify(Object.fromEntries(Object.entries(props).map(([key, value]) => [key, pair(value)])))
    .replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<!DOCTYPE html><html><body><astro-island uid="d" props="${serialized}" ssr></astro-island></body></html>`;
}

function details(milestones: unknown[], status = 200, number = NUMBER, packageId: unknown = number): string {
  return page({ parcelNumber: number, trackingDetailsStatus: status, trackingDetails: status === 200 ? { packageId, milestones } : {} });
}

const scan = (code: string, date: string, name: string) => ({ code, date, name, description: `${name}.` });

afterEach(() => vi.restoreAllMocks());

describe('InPost Spain tracking page', () => {
  it('reads the coded scans of every milestone, newest first, on Madrid clocks', () => {
    const result = parseInpostSpainPage(FIXTURE, NUMBER);
    expect(result).toMatchObject({
      status: 'out_for_delivery', current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: 'Listo para recoger en Punto Pack', last_update: '2026-10-22T11:15:00+02:00', expected_delivery: null,
      timezone: 'Europe/Madrid',
    });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.stage])).toEqual([
      ['2026-10-22T11:15:00+02:00', 'LMD.1004', 'Listo para recoger en Punto Pack', 'ready_for_pickup'],
      ['2026-10-22T08:40:12+02:00', 'LMD.1002', 'Paquete en el destino', 'in_transit'],
      ['2026-10-22T00:05:31+02:00', 'LMD.1001', 'En tránsito (último destino)', 'in_transit'],
      ['2026-10-21T16:10:00+02:00', 'MMD.1001', 'Recibido en el centro logístico', 'in_transit'],
      // The scan the page lists twice is one scan.
      ['2026-10-20T22:30:00+02:00', 'MMD.1004', 'En tránsito entre centros', 'in_transit'],
      ['2026-10-20T18:02:00+02:00', 'FMD.1002', 'Recogido por el mensajero', 'accepted'],
      ['2026-10-20T10:00:00+02:00', 'FMD.1001', 'Listo para ser recogido por el mensajero', 'registered'],
      ['2026-10-19T20:45:00+02:00', 'CRE.1001', 'En preparación', 'registered'],
    ]);
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('dates a delivery at its scan', () => {
    const result = parseInpostSpainPage(details([
      { type: 'DELIVERED', name: 'Entregado', date: '2026-11-02T10:00:00Z', events: [scan('EOL.1001', '2026-11-02T10:00:00Z', 'Entregado')] },
      { type: 'AWAITING_COLLECTION', name: 'Listo para recoger', date: '2026-10-30T09:00:00Z', events: [scan('LMD.1004', '2026-10-30T09:00:00Z', 'Listo para recoger en Punto Pack')] },
    ]), NUMBER);
    // After the clocks went back.
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-11-02T11:00:00+01:00' });
  });

  it('stages a scan it has no code for by its label, then by a movement milestone, then the parcel by the headline', () => {
    const worded = parseInpostSpainPage(details([
      { type: 'IN_TRANSIT_LAST_MILE', events: [scan('LMD.9999', '2026-10-22T07:00:00Z', 'En reparto'), scan('LMD.9998', '2026-10-22T06:00:00Z', 'Aviso pendiente')] },
      { type: 'AT_THE_ORIGIN', events: [scan('FMD.9999', '2026-10-20T08:00:00Z', 'Depositado en Punto Pack')] },
    ]), NUMBER);
    expect(worded.events!.map((event) => [event.stage, event.stage_source])).toEqual([
      ['out_for_delivery', 'wording:language'], ['in_transit', 'milestone'], [undefined, undefined],
    ]);
    expect(worded).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'wording:language' });

    const headline = parseInpostSpainPage(details([
      { type: 'DELIVERED', events: [scan('EOL.9999', '2026-11-02T10:00:00Z', 'Aviso pendiente')] },
      { type: 'IN_TRANSIT', events: [scan('MMD.1001', '2026-10-30T09:00:00Z', 'Recibido en el centro logístico')] },
    ]), NUMBER);
    expect(headline).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'milestone' });
    expect(headline).not.toHaveProperty('delivered_at');

    // A return or a failed delivery says nothing on its own: the newest staged scan decides.
    const returned = parseInpostSpainPage(details([
      { type: 'RETURN', events: [scan('RTS.1001', '2026-11-02T10:00:00Z', 'Aviso pendiente')] },
      { type: 'IN_TRANSIT', events: [scan('MMD.1001', '2026-10-30T09:00:00Z', 'Recibido en el centro logístico')] },
    ]), NUMBER);
    expect(returned).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
  });

  it('keeps the outcomes of the page’s own lookup apart', () => {
    expect(() => parseInpostSpainPage(details([], 404), NUMBER)).toThrow(NotFoundError);
    expect(() => parseInpostSpainPage(details([], 409), NUMBER)).toThrow(InputRequiredError);
    expect(() => parseInpostSpainPage(details([], 503), NUMBER)).toThrow(TransportError);
    expect(() => parseInpostSpainPage(details([], 400), NUMBER)).toThrow(SchemaError);
    expect(() => parseInpostSpainPage(details([{ type: 'IN_TRANSIT', events: [] }]), NUMBER)).toThrow(NoHistoryError);
  });

  it('reads a parcel only when the page and its details name the whole number asked', () => {
    const milestones = [{ type: 'IN_TRANSIT', events: [scan('MMD.1001', '2026-10-21T14:10:00Z', 'Recibido en el centro logístico')] }];
    expect(() => parseInpostSpainPage(details(milestones, 200, 'FV00000002', NUMBER), NUMBER)).toThrow('another number');
    expect(() => parseInpostSpainPage(details(milestones, 200, NUMBER, 'FV00000002'), NUMBER)).toThrow('another parcel');
    expect(() => parseInpostSpainPage(details(milestones, 200, NUMBER, null), NUMBER)).toThrow('another parcel');
  });

  it('refuses a changed page', () => {
    expect(() => parseInpostSpainPage('<html><body>Mantenimiento</body></html>', NUMBER)).toThrow(SchemaError);
    expect(() => parseInpostSpainPage('<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrow(ChallengeError);
    expect(() => parseInpostSpainPage(`${FIXTURE}${FIXTURE}`, NUMBER)).toThrow(SchemaError);
    expect(() => parseInpostSpainPage(page({ parcelNumber: NUMBER, trackingDetailsStatus: 200, trackingDetails: { packageId: NUMBER } }), NUMBER))
      .toThrow('without milestones');
    for (const date of ['2026-10-21 14:10:00', '2026-10-21T14:10:00', '2026-13-21T14:10:00Z', 1_700_000_000_000]) {
      expect(() => parseInpostSpainPage(details([{ type: 'IN_TRANSIT', events: [scan('MMD.1001', date as string, 'Recibido')] }]), NUMBER), String(date))
        .toThrow('invalid scan time');
    }
    const rows = Array.from({ length: 501 }, (_, index) => scan('MMD.1001', new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(), 'Recibido'));
    expect(() => parseInpostSpainPage(details([{ type: 'IN_TRANSIT', events: rows }]), NUMBER)).toThrow('oversized');
  });

  it('tracks an FV number on the page alone, without a browser or an account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(FIXTURE, { headers: { 'Content-Type': 'text/html' } }));
    const result = await new MondialRelayTracker({ fetcher, trawl: null }).fetch(' fv 0000-0001 ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(PAGE_URL);
    expect(new Headers(init?.headers).get('Accept-Language')).toBe('es-ES,es;q=0.9');
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', tracking_url: PAGE_URL, tracking_source: 'rendered-page' });
    expect(mondialRelayTrackingUrl(NUMBER)).toBe(PAGE_URL);
  });

  it('retries a page it cannot reach once, and does not take a moved page or a browser check for a parcel', async () => {
    const flaky = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(FIXTURE));
    const steps: string[] = [];
    const tracker = new MondialRelayTracker({ fetcher: flaky, trawl: null, recorder: { step: (record) => { steps.push(`${record.step}:${record.outcome}`); }, lookup() {} } });
    await expect(tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(steps).toEqual(['inpost-es:transport', 'retry:ok']);

    for (const [status, body, kind] of [
      [302, '', TransportError], [404, 'Not found', TransportError],
      [403, '<html><head><title>Just a moment...</title></head></html>', ChallengeError],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status, headers: status === 302 ? { Location: '/' } : {} }));
      await expect(new MondialRelayTracker({ fetcher, trawl: null }).fetch(NUMBER), String(status)).rejects.toBeInstanceOf(kind);
    }
  });

  it('recognizes an FV number from the page alone, and asks nothing about Mondial Relay’s own numbers', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(FIXTURE))
      .mockResolvedValueOnce(new Response(details([], 404)))
      .mockResolvedValueOnce(new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 }));
    const tracker = new MondialRelayTracker({ fetcher, trawl: null });
    await expect(tracker.recognize(' fv 0000-0001 ')).resolves.toMatchObject({ known: true });
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: false });
    // A browser check is no answer.
    await expect(tracker.recognize(NUMBER)).rejects.toBeInstanceOf(ChallengeError);
    for (const number of ['12345678', '1234567890', '123456789012', 'FV0000001', 'FV000000001']) {
      await expect(tracker.recognize(number), number).resolves.toEqual({ known: false });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('is offered and asked first for FV and eight digits, and asked about no other number', async () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(NUMBER).candidates).toContain('mondial-relay');
    expect(recognitionAskedCarriers(NUMBER)[0]).toBe('mondial-relay');
    for (const number of ['FV0000001', 'FV000000001', 'FW00000001']) expect(detectCarrierMatch(number).candidates, number).not.toContain('mondial-relay');
    for (const number of ['12345678', '1234567890', '123456789012']) expect(recognitionAskedCarriers(number), number).not.toContain('mondial-relay');
    vi.useFakeTimers({ now: new Date('2026-10-23T12:00:00Z'), toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input) === PAGE_URL
        ? new Response(FIXTURE) : new Response('Not found', { status: 404 }));
      await expect(createTracker({ fetcher, providers: [], env: {} }).recognize(NUMBER, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: 'mondial-relay' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves Mondial Relay’s own numbers to the app and the website', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new MondialRelayTracker({ fetcher, trawl: null }).fetch('12345678')).rejects.toBeInstanceOf(InputRequiredError);
    await expect(new MondialRelayTracker({ fetcher, trawl: null }).fetch('FV0000001')).rejects.toThrow('InPost Spain number');
    await expect(new MondialRelayTracker({ fetcher, trawl: null }).fetch('1234567890')).rejects.toBeInstanceOf(ChallengeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
