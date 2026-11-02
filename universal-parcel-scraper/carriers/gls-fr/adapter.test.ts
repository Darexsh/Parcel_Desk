import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { SchemaError } from '../../core/errors/index.js';
import {
  GLSFranceTracker,
  adapter,
  glsFranceDepot,
  glsFrancePickupPoint,
  glsFranceTrackingApiUrl,
  glsFranceTrackingUrl,
  normalizeGLSFranceTrackingNumber,
  parseGLSFranceTrackingResponse,
} from './adapter.js';
import { glsFranceStatus } from './status.js';

const TRACKING_NUMBER = '00AB12CD';
const NUMERIC_TRACKING_NUMBER = '36631000001';
/** The same parcel number printed with its GLS check digit. */
const PRINTED_TRACKING_NUMBER = '366310000017';
const CAPABILITIES: readonly string[] = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'carrier.json'), 'utf8'),
).capabilities;
const POINT = '2503999999';
const NODE_API = 'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v2/searchNode';
const AGENCY_API = 'https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/agency';
const SHOP = "EXAMPLE TABAC PRESSE\n1 RUE DE L'EXEMPLE\n99999 Exempleville";
const DEPOT_CODE = 'FR0012';
const DEPOT = "EXEMPLEVILLE GLS FRANCE\n1 RUE DE L'EXEMPLE\nZONE D'ACTIVITE DE L'EXEMPLE\n99999 EXEMPLEVILLE";

interface Fixture {
  colis: Record<string, unknown>;
  adresse: Record<string, unknown>;
  evenements: Record<string, unknown>[];
}

function deliveredFixture(): Fixture {
  return JSON.parse(readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'delivered.json'),
    'utf8',
  )) as Fixture;
}

/** The same parcel the morning of its delivery, still out with the driver. */
function outForDeliveryFixture(): Fixture {
  const fixture = deliveredFixture();
  fixture.colis.statutColis = 'TRV';
  fixture.evenements = [fixture.evenements[0]!, {
    datereference: '2026-08-29 07:20:00.0',
    statutEvenement: 'TRV',
    typeEvenement: 'TRV',
    codelieuEvenement: 'FR0012',
  }];
  return fixture;
}

/** The same parcel waiting at the shop the point fixture describes. */
function waitingFixture(): Fixture {
  const fixture = deliveredFixture();
  fixture.colis.statutColis = 'LIP';
  fixture.colis.relaisGlsColis = POINT;
  fixture.colis.codeActionColis = 0;
  fixture.evenements = [fixture.evenements[0]!, {
    datereference: '2026-08-29 10:05:00.0',
    statutEvenement: 'LIP',
    typeEvenement: 'INF',
    codelieuEvenement: 'FR0012',
    relaisglsEvenement: POINT,
  }];
  return fixture;
}

/** The same parcel waiting for collection at its delivery depot. */
function depotFixture(): Fixture {
  const fixture = deliveredFixture();
  fixture.colis.statutColis = 'PAQ';
  fixture.colis.lieuTheoriqueLivraison = DEPOT_CODE;
  fixture.colis.codeActionColis = 0;
  fixture.evenements = [fixture.evenements[0]!, {
    datereference: '2026-08-29 10:05:00.0',
    statutEvenement: 'PAQ',
    typeEvenement: 'INF',
    codelieuEvenement: DEPOT_CODE,
  }];
  return fixture;
}

function recordFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name),
    'utf8',
  )) as Record<string, unknown>;
}

function pointFixture(): Record<string, unknown> {
  return recordFixture('pickup-point.json');
}

function depotRecord(): Record<string, unknown> {
  return recordFixture('depot.json');
}

type Reply = () => Response | Promise<Response>;

function pickupLookup(
  parcel: Fixture,
  node: Reply = () => new Response(JSON.stringify(pointFixture())),
  agency: Reply = () => new Response(JSON.stringify(depotRecord())),
) {
  const urls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith(NODE_API)) return node();
    return url.startsWith(AGENCY_API) ? agency() : new Response(JSON.stringify(parcel));
  });
  return { urls, fetcher, tracker: new GLSFranceTracker({ timeoutMs: 1_000, fetcher }) };
}

afterEach(() => vi.restoreAllMocks());

describe('GLS France tracking input', () => {
  it('normalizes official identifiers and builds public URLs', () => {
    expect(normalizeGLSFranceTrackingNumber('00ab-12.cd')).toBe(TRACKING_NUMBER);
    expect(normalizeGLSFranceTrackingNumber('36631 000-001')).toBe(NUMERIC_TRACKING_NUMBER);

    expect(glsFranceTrackingUrl(TRACKING_NUMBER))
      .toBe(`https://moncolis.gls-france.com/fr/${TRACKING_NUMBER}`);
    expect(glsFranceTrackingApiUrl(NUMERIC_TRACKING_NUMBER)).toBe(
      `https://public.infra-prod.prod.cloud.fr.gls-group.com/consignee-ws/api/v1/command/public/codes/${NUMERIC_TRACKING_NUMBER}`,
    );
  });

  it('knows a 12-digit printed number by its 11-digit parcel number', () => {
    expect(normalizeGLSFranceTrackingNumber('3663 1000 0017')).toBe(NUMERIC_TRACKING_NUMBER);
    expect(glsFranceTrackingUrl(PRINTED_TRACKING_NUMBER)).toBe(`https://moncolis.gls-france.com/fr/${NUMERIC_TRACKING_NUMBER}`);
    // A wrong check digit is not a GLS number.
    expect(() => normalizeGLSFranceTrackingNumber('366310000018')).toThrow('12 with a valid check digit');
  });

  it('rejects unsupported or unsafe identifiers', () => {
    for (const value of [
      'ABC1234',
      'ABC123456',
      '3663100000A',
      '00AB12/CD',
      '00AB12CÉ',
      '00AB12CD?admin=true',
    ]) {
      expect(() => normalizeGLSFranceTrackingNumber(value)).toThrow('8 letters or digits, or 11 digits');
    }
  });
});

describe('GLS France HTTP recognition', () => {
  const createAdapter = (fetcher: typeof fetch) => adapter({
    fetcher, trawl: null, browserExecutablePath: null, env: {},
    recorder: { step() {}, lookup() {} },
  });

  it('holds back a scan entered at its planned time until it is due', () => {
    expect(createAdapter(vi.fn<typeof fetch>()).plannedScans).toBe(true);
  });

  it('confirms the requested parcel through the French endpoint and reports its scan clock', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(deliveredFixture())));
    await expect(createAdapter(fetcher).recognize!(TRACKING_NUMBER, { budgetMs: 1_000 })).resolves.toEqual({
      known: true, lastActivityAt: '2026-08-29T09:42:00.000Z',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(glsFranceTrackingApiUrl(TRACKING_NUMBER));
  });

  it('returns unknown without I/O for unsupported numbers and for definite absence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`404 No command found for code: ${TRACKING_NUMBER}`, { status: 404 }));
    const instance = createAdapter(fetcher);
    await expect(instance.recognize!('ABC1234')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(instance.recognize!(TRACKING_NUMBER)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps generic missing routes and mismatched negative replies as failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response('Gone', { status: 410 }))
      .mockResolvedValueOnce(new Response('404 No command found for code: 00EF34GH', { status: 404 }));
    const instance = createAdapter(fetcher);
    for (const status of [404, 410, 404]) {
      await expect(instance.recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'transport', status });
    }
  });

  it('keeps unmatched identity and endpoint failures inconclusive', async () => {
    const fixture = deliveredFixture();
    fixture.colis.trackid = '00EF34GH';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(fixture)))
      .mockResolvedValueOnce(new Response('Too many requests', { status: 429 }))
      .mockResolvedValueOnce(new Response('<html>Verification required</html>'));
    const instance = createAdapter(fetcher);
    await expect(instance.recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(instance.recognize!(TRACKING_NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
    await expect(instance.recognize!(TRACKING_NUMBER)).rejects.toThrow('invalid tracking response');
  });

  it('propagates caller cancellation and the recognition budget', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      return new Response('{}');
    });
    const instance = createAdapter(fetcher);
    await expect(instance.recognize!(TRACKING_NUMBER, { signal: controller.signal })).rejects.toThrow('caller cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    // Room enough that a pause on a busy runner cannot spend the retry's half too.
    await expect(instance.recognize!(TRACKING_NUMBER, { budgetMs: 1_000 })).rejects.toThrow();
    // The first request gets half of the budget, and its retry the rest.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });
});

describe('GLS France status mapping', () => {
  it.each([
    [['CON'], 'pending'],
    [['REC', 'EXP', 'PBC', 'DOU', 'DEL'], 'in_transit'],
    [['TRV'], 'out_for_delivery'],
    [['LIV', 'LTV', 'LTL', 'LIL', 'LIT', 'LTT'], 'delivered'],
    [['INC', 'PBP', 'NLI', 'NLK', 'NLP', 'RET', 'PBA', 'SIN'], 'exception'],
    [['LIP', 'LTP', 'LIK', 'LTK', 'PAQ'], 'out_for_delivery'],
  ] as const)('maps %j to %s', (codes, expected) => {
    for (const code of codes) expect(glsFranceStatus(code)).toBe(expected);
  });

  it('does not guess an unknown provider code', () => {
    expect(glsFranceStatus('NEW')).toBe('unknown');
    expect(glsFranceStatus({ code: 'LIV' })).toBe('unknown');
  });

  it('leaves an unmapped code without a stage so the sync can classify it', () => {
    const fixture = deliveredFixture();
    fixture.colis.statutColis = 'NEW';
    fixture.evenements = [{
      datereference: '2026-08-29 11:42:00.0',
      statutEvenement: 'NEW',
      typeEvenement: 'NEW',
      codelieuEvenement: 'FR0012',
    }];

    const result = parseGLSFranceTrackingResponse(fixture, TRACKING_NUMBER);
    expect(result.status).toBe('unknown');
    expect(result.events?.[0]).toEqual({
      time: '2026-08-29T11:42:00+02:00',
      location: 'FR0012',
      description: 'GLS France tracking update',
      provider_code: 'NEW',
    });
  });
});

describe('GLS France response normalization', () => {
  it('sorts and normalizes safe events without retaining recipient or address data', () => {
    const result = parseGLSFranceTrackingResponse(deliveredFixture(), TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-08-29T11:42:00+02:00',
      expected_delivery: null,
      sender_name: 'Example Shop',
      delivered_at: '2026-08-29T11:42:00+02:00',
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([{
      time: '2026-08-29T11:42:00+02:00',
      location: 'FR0012',
      description: 'Delivered',
      stage: 'delivered',
      provider_code: 'LIV',
    }, {
      time: '2026-08-28T08:10:00+02:00',
      location: 'FR9900',
      description: 'Shipment information received',
      stage: 'registered',
      provider_code: 'CON',
    }]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'Private Recipient',
      'Private delivery instruction',
      'Private Company',
      'Private Street',
      'private@example.test',
      'private address code',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('reads a depot receipt as the acceptance only before the parcel moved on', () => {
    const fixture = deliveredFixture();
    fixture.colis.statutColis = 'REC';
    const scan = (datereference: string, code: string) => ({ datereference, statutEvenement: code, typeEvenement: code, codelieuEvenement: DEPOT_CODE });
    fixture.evenements = [fixture.evenements[0]!, scan('2026-08-27 18:00:00.0', 'REC'), scan('2026-08-28 12:00:00.0', 'EXP'),
      scan('2026-08-29 01:00:00.0', 'REC'), scan('2026-08-29 05:00:00.0', 'TRV'), scan('2026-08-29 08:00:00.0', 'REC')];
    const result = parseGLSFranceTrackingResponse(fixture, TRACKING_NUMBER);
    expect(result.status).toBe('in_transit');
    expect(result.events!.filter((event) => event.provider_code !== 'CON').map((event) => [event.provider_code, event.stage])).toEqual([
      ['REC', 'in_transit'], ['TRV', 'out_for_delivery'], ['REC', 'in_transit'], ['EXP', 'in_transit'], ['REC', 'accepted'],
    ]);
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const fixture = deliveredFixture();
    const scan = (code: string) => ({ datereference: '2026-08-29 08:00:00.0', statutEvenement: code, typeEvenement: code, codelieuEvenement: DEPOT_CODE });
    fixture.evenements = [fixture.evenements[0]!, scan('REC'), scan('TRV')];
    expect(parseGLSFranceTrackingResponse(fixture, TRACKING_NUMBER).events!.map((event) => event.provider_code)).toEqual(['TRV', 'REC', 'CON']);
  });

  it('dates the delivery only once the parcel is delivered', () => {
    expect(parseGLSFranceTrackingResponse(outForDeliveryFixture(), TRACKING_NUMBER)).not.toHaveProperty('delivered_at');
  });

  it('keeps the planned day only while the parcel is still on its way', () => {
    expect(parseGLSFranceTrackingResponse(outForDeliveryFixture(), TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      expected_delivery: '2026-08-29',
      sender_name: 'Example Shop',
    });
    const failed = outForDeliveryFixture();
    failed.colis.statutColis = 'NLI';
    expect(parseGLSFranceTrackingResponse(failed, TRACKING_NUMBER).expected_delivery).toBeNull();
    const unnamed = outForDeliveryFixture();
    unnamed.colis.libelleExpediteur = '   ';
    expect(parseGLSFranceTrackingResponse(unnamed, TRACKING_NUMBER)).not.toHaveProperty('sender_name');
  });

  it('returns every capability declared in carrier.json', async () => {
    const result = parseGLSFranceTrackingResponse(outForDeliveryFixture(), TRACKING_NUMBER);
    const delivered = parseGLSFranceTrackingResponse(deliveredFixture(), TRACKING_NUMBER);
    const waiting = await pickupLookup(waitingFixture()).tracker.fetch(TRACKING_NUMBER);
    const checks: Record<string, () => boolean> = {
      history: () => (result.events?.length ?? 0) > 0,
      location: () => (result.events ?? []).some((event) => Boolean(event.location)),
      eta: () => result.expected_delivery != null,
      sender_name: () => result.sender_name != null,
      pickup_point: () => Boolean(waiting.pickup_point),
      provider_code: () => (result.events ?? []).some((event) => Boolean(event.provider_code)),
      delivered_at: () => Boolean(delivered.delivered_at),
    };
    expect(CAPABILITIES.length).toBeGreaterThan(0);
    for (const capability of CAPABILITIES) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(checks[capability]!(), `capability ${capability} is declared but never returned`).toBe(true);
    }
  });

  it('accepts the matching numeric identifier and maps pickup readiness', () => {
    const fixture = deliveredFixture();
    fixture.colis.trackid = '00EF34GH';
    fixture.colis.numeroalphaColis = Number(NUMERIC_TRACKING_NUMBER);
    fixture.colis.statutColis = 'LIK';
    fixture.evenements = [{
      datereference: '2026-08-29 09:15:00.0',
      statutEvenement: 'LIK',
      typeEvenement: 'INF',
      codelieuEvenement: 'FR0042',
      nomSignataire: '',
      referenceDestinataire: '',
    }];

    expect(parseGLSFranceTrackingResponse(fixture, NUMERIC_TRACKING_NUMBER)).toMatchObject({
      status: 'out_for_delivery',
      last_status_text: 'Ready for pickup at GLS Locker',
      expected_delivery: null,
      events: [{ stage: 'ready_for_pickup', provider_code: 'LIK' }],
    });
  });

  it('treats DEL as scheduled unless the latest provider event is a failed LIV attempt', () => {
    const scheduled = deliveredFixture();
    scheduled.colis.statutColis = 'DEL';
    scheduled.evenements = [{
      datereference: '2026-08-29 11:42:00.0',
      statutEvenement: 'DEL',
      typeEvenement: 'EXP',
      codelieuEvenement: 'FR0012',
      nomSignataire: '',
      referenceDestinataire: '',
    }];

    expect(parseGLSFranceTrackingResponse(scheduled, TRACKING_NUMBER)).toMatchObject({
      status: 'in_transit',
      last_status_text: 'Delivery delayed',
      events: [{
        description: 'Delivery delayed',
        stage: 'in_transit',
        provider_code: 'DEL',
      }],
    });

    const failed = deliveredFixture();
    failed.colis.statutColis = 'DEL';
    failed.evenements = [{
      datereference: '2026-08-29 11:42:00.0',
      statutEvenement: 'DEL',
      typeEvenement: 'LIV',
      codelieuEvenement: 'FR0012',
      nomSignataire: '',
      referenceDestinataire: '',
    }];

    expect(parseGLSFranceTrackingResponse(failed, TRACKING_NUMBER)).toMatchObject({
      status: 'exception',
      last_status_text: 'Delivery delayed',
      events: [{
        description: 'Delivery delayed',
        stage: 'failed_attempt',
        provider_code: 'DEL',
      }],
    });

    failed.colis.statutColis = 'NEW';
    expect(parseGLSFranceTrackingResponse(failed, TRACKING_NUMBER))
      .toMatchObject({ status: 'exception' });
  });

  it('rejects malformed responses and responses for another shipment', () => {
    expect(() => parseGLSFranceTrackingResponse([], TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseGLSFranceTrackingResponse([], TRACKING_NUMBER))
      .toThrow('invalid tracking response');
    expect(() => parseGLSFranceTrackingResponse({ colis: { statutColis: 'CON' } }, TRACKING_NUMBER))
      .toThrow('did not return a shipment identifier');

    const fixture = deliveredFixture();
    fixture.colis.trackid = '00EF34GH';
    expect(() => parseGLSFranceTrackingResponse(fixture, TRACKING_NUMBER))
      .toThrow('different shipment');
  });

  it('fetches and parses the bounded public JSON endpoint', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify(deliveredFixture()),
      { headers: { 'Content-Type': 'application/json' } },
    ));

    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [requested, init] = fetcher.mock.calls[0]!;
    expect(String(requested)).toBe(glsFranceTrackingApiUrl(TRACKING_NUMBER));
    expect(init).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({
        Accept: 'application/json',
        Origin: 'https://moncolis.gls-france.com',
      }),
    });
  });

  it('preserves the official wrong-number 404 for a validly shaped parcel number', async () => {
    const wrongNumber = '00ZZ00Z0';
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      `404 No command found for code: ${wrongNumber}`,
      { status: 404 },
    ));

    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(wrongNumber)).rejects.toMatchObject({
      name: 'UpstreamHttpError',
      provider: 'GLS France tracking',
      kind: 'not_found',
      status: 404,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe(glsFranceTrackingApiUrl(wrongNumber));
  });

  it('looks a printed number up by its parcel number, then as printed once', async () => {
    const found = () => {
      const fixture = deliveredFixture();
      fixture.colis.numeroGp = PRINTED_TRACKING_NUMBER;
      return new Response(JSON.stringify(fixture), { headers: { 'Content-Type': 'application/json' } });
    };
    const direct = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(found());
    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(PRINTED_TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(direct.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([NUMERIC_TRACKING_NUMBER]);
    direct.mockRestore();

    const fallback = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(`404 No command found for code: ${NUMERIC_TRACKING_NUMBER}`, { status: 404 }))
      .mockResolvedValueOnce(found());
    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(PRINTED_TRACKING_NUMBER))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fallback.mock.calls.map(([url]) => String(url).split('/').at(-1)))
      .toEqual([NUMERIC_TRACKING_NUMBER, PRINTED_TRACKING_NUMBER]);
    fallback.mockRestore();

    // Two not-founds stay a not-found; an 11-digit number is asked once.
    const missing = vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
      new Response(`404 No command found for code: ${String(url).split('/').at(-1)}`, { status: 404 }));
    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(PRINTED_TRACKING_NUMBER)).rejects.toMatchObject({ status: 404, kind: 'not_found' });
    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(NUMERIC_TRACKING_NUMBER)).rejects.toMatchObject({ status: 404 });
    expect(missing).toHaveBeenCalledTimes(3);
  });

  it('does not retry a printed number after an unavailable API route', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Not Found', { status: 404 }));
    await expect(new GLSFranceTracker({ fetcher }).fetch(PRINTED_TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'transport', status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not ask for the number as printed once the caller has cancelled', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      controller.abort(new Error('caller cancelled'));
      return new Response('404 No command found', { status: 404 });
    });

    await expect(new GLSFranceTracker({ timeoutMs: 1_000, fetcher }).fetch(PRINTED_TRACKING_NUMBER, { signal: controller.signal }))
      .rejects.toThrow('caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries a request that hangs once, inside the budget, but not a not-found', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: 300, reply: () => Response.json(deliveredFixture()) }]);
    const lookup = new GLSFranceTracker({ fetcher }).fetch(TRACKING_NUMBER);
    await vi.advanceTimersByTimeAsync(12_300);
    await expect(lookup).resolves.toMatchObject({ status: 'delivered' });
    // Half of the 24-second default budget, then the retry within the rest.
    expect(ended).toEqual([12_000, 12_300]);
    const wrongNumber = '00ZZ00Z0';
    const missing = delayedFetcher([{ afterMs: 10, reply: () => new Response(`404 No command found for code: ${wrongNumber}`, { status: 404 }) }]);
    const unknown = expect(new GLSFranceTracker({ fetcher: missing.fetcher }).fetch(wrongNumber)).rejects.toMatchObject({ kind: 'not_found' });
    await vi.advanceTimersByTimeAsync(10);
    await unknown;
    expect(missing.fetcher).toHaveBeenCalledOnce();
  });

  it('enforces the adapter response-size limit', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      headers: { 'Content-Length': '750001' },
    }));

    await expect(new GLSFranceTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow('unexpectedly large response');
  });
});

describe('GLS France pickup point', () => {
  it('names the shop holding the parcel and its address only while it waits there', async () => {
    const app = pickupLookup(waitingFixture());
    const result = await app.tracker.fetch(TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', pickup_point: SHOP });
    expect(app.urls).toEqual([glsFranceTrackingApiUrl(TRACKING_NUMBER), `${NODE_API}/${TRACKING_NUMBER}/${POINT}`]);
    expect(app.fetcher.mock.calls[1]![1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({ Origin: 'https://moncolis.gls-france.com' }),
    });
    expect(JSON.stringify(result)).not.toMatch(/MONDAY|09:00|0\.000000|Private|private/);

    const collected = waitingFixture();
    collected.colis.statutColis = 'LIV';
    const done = pickupLookup(collected);
    const delivered = await done.tracker.fetch(TRACKING_NUMBER);
    expect(delivered).toMatchObject({ status: 'delivered' });
    expect(delivered.pickup_point).toBeUndefined();
    expect(done.urls).toHaveLength(1);
  });

  it.each(['LIP', 'LTP', 'LIK', 'LTK'])('asks for the point while the parcel status is %s', async (code) => {
    const fixture = waitingFixture();
    fixture.colis.statutColis = code;
    fixture.evenements[1]!.statutEvenement = code;
    const app = pickupLookup(fixture);
    await expect(app.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ pickup_point: SHOP });
    expect(app.urls).toHaveLength(2);
  });

  it('reads the waiting status from the newest event when the parcel has none', async () => {
    const fixture = waitingFixture();
    delete fixture.colis.statutColis;
    const app = pickupLookup(fixture);
    await expect(app.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ pickup_point: SHOP });

    fixture.evenements[1]!.statutEvenement = 'PAQ';
    fixture.colis.lieuTheoriqueLivraison = DEPOT_CODE;
    const depot = pickupLookup(fixture);
    await expect(depot.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ pickup_point: DEPOT });
    expect(depot.urls[1]).toBe(`${AGENCY_API}/${TRACKING_NUMBER}/${DEPOT_CODE}`);
  });

  it('asks for the point under the parcel code its record gives, as the tracking page does', async () => {
    const fixture = waitingFixture();
    fixture.colis.numeroalphaColis = Number(NUMERIC_TRACKING_NUMBER);
    const app = pickupLookup(fixture);
    await expect(app.tracker.fetch(NUMERIC_TRACKING_NUMBER)).resolves.toMatchObject({ pickup_point: SHOP });
    expect(app.urls[1]).toBe(`${NODE_API}/${TRACKING_NUMBER}/${POINT}`);
  });

  it('never asks for a neighbour, or a point the parcel is not waiting at', async () => {
    const changes: Array<(fixture: Fixture) => void> = [
      (fixture) => { fixture.colis.relaisGlsColis = '2501999999'; },
      // Collection at the depot was asked for.
      (fixture) => { fixture.colis.codeActionColis = 20; },
      (fixture) => { fixture.colis.relaisGlsColis = '0'; },
      (fixture) => { fixture.colis.relaisGlsColis = ''; },
      (fixture) => { fixture.colis.relaisGlsColis = '2503/../99'; },
      (fixture) => { delete fixture.colis.relaisGlsColis; },
      (fixture) => {
        fixture.colis.statutColis = 'TRV';
        fixture.evenements[1]!.statutEvenement = 'TRV';
      },
    ];
    for (const change of changes) {
      const fixture = waitingFixture();
      change(fixture);
      const app = pickupLookup(fixture);
      expect((await app.tracker.fetch(TRACKING_NUMBER)).pickup_point).toBeUndefined();
      expect(app.urls).toEqual([glsFranceTrackingApiUrl(TRACKING_NUMBER)]);
    }
  });

  it('reads a shop and a locker as their records give them, and never a neighbour', () => {
    const shop = pointFixture();
    expect(glsFrancePickupPoint(shop, POINT)).toBe(SHOP);
    expect(glsFrancePickupPoint({ ...shop, name: 'EXAMPLE LOCKER', type: 'LOCKER', parcelShopType: 'LOCKER' }, POINT))
      .toBe("EXAMPLE LOCKER\n1 RUE DE L'EXEMPLE\n99999 Exempleville");
    expect(glsFrancePickupPoint({ ...shop, parcelShopType: 'NEIGHBOUR' }, POINT)).toBe('');
    expect(glsFrancePickupPoint({ ...shop, type: 'KEEPER' }, POINT)).toBe('');
    expect(glsFrancePickupPoint({ ...shop, parcelShopType: null }, POINT)).toBe('');
    expect(glsFrancePickupPoint(shop, '2503999998')).toBe('');
  });

  it('keeps the name alone without a street or town, and nothing without a name', () => {
    const shop = pointFixture();
    const address = shop.address as Record<string, unknown>;
    expect(glsFrancePickupPoint({ ...shop, address: { ...address, street: ' ' } }, POINT)).toBe('EXAMPLE TABAC PRESSE');
    expect(glsFrancePickupPoint({ ...shop, address: { ...address, city: null } }, POINT)).toBe('EXAMPLE TABAC PRESSE');
    expect(glsFrancePickupPoint({ ...shop, address: 'EXAMPLE' }, POINT)).toBe('EXAMPLE TABAC PRESSE');
    expect(glsFrancePickupPoint({ ...shop, address: { ...address, zipCode: 'EXAMPLE' } }, POINT))
      .toBe("EXAMPLE TABAC PRESSE\n1 RUE DE L'EXEMPLE\nExempleville");
    expect(glsFrancePickupPoint({ ...shop, name: ['EXAMPLE'] }, POINT)).toBe('');
    expect(glsFrancePickupPoint([shop], POINT)).toBe('');
  });

  it.each([
    ['another point', () => new Response(JSON.stringify({ ...pointFixture(), parcelShopId: '2503999998' }))],
    ['an empty record', () => new Response('{}')],
    ['a blocked reply', () => new Response('<html>sorry</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['an outage', () => new Response('', { status: 503 })],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('keeps the parcel without a pickup point after %s', async (_, reply) => {
    const result = await pickupLookup(waitingFixture(), reply).tracker.fetch(TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Ready for pickup at GLS ParcelShop' });
    expect(result.events?.[0]).toMatchObject({ provider_code: 'LIP' });
    expect(result.pickup_point).toBeUndefined();
  });

  it('ends a lookup cancelled during the point request', async () => {
    const controller = new AbortController();
    const app = pickupLookup(waitingFixture(), () => {
      controller.abort(new Error('caller cancelled'));
      return new Response('', { status: 503 });
    });
    await expect(app.tracker.fetch(TRACKING_NUMBER, { signal: controller.signal })).rejects.toThrow('caller cancelled');
  });

  it.each([['a shop', waitingFixture], ['a depot', depotFixture]])('recognizes a parcel waiting at %s without asking for its point', async (_, fixture) => {
    const app = pickupLookup(fixture());
    const instance = adapter({
      fetcher: app.fetcher, trawl: null, browserExecutablePath: null, env: {},
      recorder: { step() {}, lookup() {} },
    });
    await expect(instance.recognize!(TRACKING_NUMBER, { budgetMs: 1_000 })).resolves.toMatchObject({ known: true });
    expect(app.urls).toEqual([glsFranceTrackingApiUrl(TRACKING_NUMBER)]);
  });
});

describe('GLS France depot', () => {
  it('names the depot holding the parcel for collection and its address', async () => {
    const app = pickupLookup(depotFixture());
    const result = await app.tracker.fetch(TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      last_status_text: 'Ready for pickup at GLS depot',
      pickup_point: DEPOT,
    });
    expect(app.urls).toEqual([glsFranceTrackingApiUrl(TRACKING_NUMBER), `${AGENCY_API}/${TRACKING_NUMBER}/${DEPOT_CODE}`]);
    expect(app.fetcher.mock.calls[1]![1]).toMatchObject({
      cache: 'no-store',
      redirect: 'error',
      headers: expect.objectContaining({ Origin: 'https://moncolis.gls-france.com' }),
    });
    expect(JSON.stringify(result)).not.toMatch(/\+33|8h30|Lun au Ven|Exempleville FR0012/);
  });

  it('asks for the depot, never the shop, once collection there was asked for or the parcel went back', async () => {
    const asked = depotFixture();
    asked.colis.codeActionColis = 20;
    const collection = pickupLookup(asked);
    await expect(collection.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ pickup_point: DEPOT });
    expect(collection.urls[1]).toBe(`${AGENCY_API}/${TRACKING_NUMBER}/${DEPOT_CODE}`);

    // The record still names the shop the parcel was meant for.
    const back = depotFixture();
    back.colis.relaisGlsColis = POINT;
    const depot = pickupLookup(back);
    await expect(depot.tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ pickup_point: DEPOT });
    expect(depot.urls).toHaveLength(2);
    expect(depot.urls.some((url) => url.startsWith(NODE_API))).toBe(false);
  });

  it('asks for no depot while the parcel is not waiting there, or without a depot code', async () => {
    const changes: Array<(fixture: Fixture) => void> = [
      (fixture) => {
        fixture.colis.statutColis = 'LIV';
        fixture.colis.codeActionColis = 20;
      },
      (fixture) => {
        fixture.colis.statutColis = 'TRV';
        fixture.evenements[1]!.statutEvenement = 'TRV';
      },
      (fixture) => { delete fixture.colis.lieuTheoriqueLivraison; },
      (fixture) => { fixture.colis.lieuTheoriqueLivraison = ''; },
      (fixture) => { fixture.colis.lieuTheoriqueLivraison = 'FR12'; },
      (fixture) => { fixture.colis.lieuTheoriqueLivraison = 'FR/../1'; },
      (fixture) => { fixture.colis.lieuTheoriqueLivraison = { code: DEPOT_CODE }; },
    ];
    for (const change of changes) {
      const fixture = depotFixture();
      change(fixture);
      const app = pickupLookup(fixture);
      expect((await app.tracker.fetch(TRACKING_NUMBER)).pickup_point).toBeUndefined();
      expect(app.urls).toEqual([glsFranceTrackingApiUrl(TRACKING_NUMBER)]);
    }
  });

  it('reads the depot its record gives, as the tracking page prints it', () => {
    const depot = depotRecord();
    expect(glsFranceDepot(depot, DEPOT_CODE)).toBe(DEPOT);
    expect(glsFranceDepot({ ...depot, codeLieu: 'fr0012' }, DEPOT_CODE)).toBe(DEPOT);
    expect(glsFranceDepot({ ...depot, libelleAdresse2Lieu: null, libelleAdresse3Lieu: 'EXEMPLE CEDEX' }, DEPOT_CODE))
      .toBe("EXEMPLEVILLE GLS FRANCE\n1 RUE DE L'EXEMPLE\nEXEMPLE CEDEX\n99999 EXEMPLEVILLE");
    expect(glsFranceDepot({ ...depot, codepostalLieu: 'EXEMPLE' }, DEPOT_CODE))
      .toBe("EXEMPLEVILLE GLS FRANCE\n1 RUE DE L'EXEMPLE\nZONE D'ACTIVITE DE L'EXEMPLE\nEXEMPLEVILLE");
  });

  it('keeps the name alone without a street or town, and nothing for another depot or without a name', () => {
    const depot = depotRecord();
    const noStreet = { ...depot, libelleAdresse1Lieu: ' ', libelleAdresse2Lieu: null, libelleAdresse3Lieu: '' };
    expect(glsFranceDepot(noStreet, DEPOT_CODE)).toBe('EXEMPLEVILLE GLS FRANCE');
    expect(glsFranceDepot({ ...depot, villeLieu: null }, DEPOT_CODE)).toBe('EXEMPLEVILLE GLS FRANCE');
    expect(glsFranceDepot({ ...depot, codeLieu: 'FR0013' }, DEPOT_CODE)).toBe('');
    expect(glsFranceDepot({ ...depot, codeLieu: undefined }, DEPOT_CODE)).toBe('');
    expect(glsFranceDepot({ ...depot, libelleLieu: ['EXAMPLE'] }, DEPOT_CODE)).toBe('');
    expect(glsFranceDepot([depot], DEPOT_CODE)).toBe('');
  });

  it.each([
    ['another depot', () => new Response(JSON.stringify({ ...depotRecord(), codeLieu: 'FR0013' }))],
    ['the error the endpoint gives an unknown code', () => new Response('{"code_erreur":"E999:Exception"}', { status: 500 })],
    ['a blocked reply', () => new Response('<html>sorry</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
  ])('keeps the parcel without a pickup point after %s', async (_, reply) => {
    const result = await pickupLookup(depotFixture(), undefined, reply).tracker.fetch(TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', last_status_text: 'Ready for pickup at GLS depot' });
    expect(result.pickup_point).toBeUndefined();
  });
});
