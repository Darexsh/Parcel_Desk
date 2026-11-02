import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { STAGES } from '../../core/status/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { DhlEcommercePlTracker, adapter, solveDhlEcommercePlChallenge } from './adapter.js';
import { normalizeDhlEcommercePlNumber, parseDhlEcommercePl, parseDhlEcommercePlChallenge, parseDhlEcommercePlRejection } from './parser.js';
import { dhlEcommercePlStatus, dhlPolandScanStage, statusMap } from './status.js';

const NUMBER = 'JJD000039999999000000000000';
const WAYBILL = '99999999990';
const SALT = '0123456789abcdef01234567?expires=4102444800';
const SECRET = 4321;
const clone = () => structuredClone(fixture);
const shipment = (payload: ReturnType<typeof clone>) => payload[0]!.shipments[0]! as Record<string, unknown>;
const environment = (fetcher: typeof fetch) => ({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });
const challenge = (secret = SECRET, maxnumber = 100_000) => ({ algorithm: 'SHA-256',
  challenge: createHash('sha256').update(SALT + secret).digest('hex'), salt: SALT, signature: 'ab'.repeat(32), maxnumber });
const never = new AbortController().signal;
/** A portal that issues a solvable challenge and gives `answer` to the lookup. */
const portal = (answer: () => Response, seen: { url: string; init?: RequestInit }[] = []): typeof fetch => async (url, init) => {
  seen.push({ url: String(url), init });
  return String(url).endsWith('/auth/captcha/challenge') ? Response.json(challenge()) : answer();
};

describe('DHL eCommerce Poland parser', () => {
  it('reads a delivered parcel as its current status and names its sender', () => {
    const result = normalizeCarrierResult(parseDhlEcommercePl(clone(), NUMBER));
    expect(result.status).toBe('delivered');
    expect(result.current_stage).toBe('delivered');
    expect(result.last_status_text).toBe('Parcel has been delivered');
    expect(result.last_update).toBe('2026-03-04T09:15:00Z');
    expect(result.delivered_at).toBe('2026-03-04T09:15:00Z');
    expect(result.expected_delivery).toBeNull();
    expect(result.summary_only).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.sender_name).toBe('Example Sender');
    expect(JSON.stringify(result)).not.toMatch(/99999999990|dhl24/);
    const unnamed = clone(); shipment(unnamed).sender = ' ';
    expect(parseDhlEcommercePl(unnamed, NUMBER)).not.toHaveProperty('sender_name');
  });

  it('times a return by its receipt at the sender without calling it a delivery', () => {
    const payload = clone();
    Object.assign(shipment(payload), { status: 'TT_DOR_ZWN', timelineStep: 'DeliveredToSender', step: 'The parcel has returned to Sender',
      receiptDateUtc: '2026-03-09T10:00:00Z', deliveryDateUtc: '2026-03-09T10:00:00Z', planOfDeliveryFromUtc: '2026-03-03T23:00:00Z' });
    const result = parseDhlEcommercePl(payload, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: '2026-03-09T10:00:00Z', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('reads the same shipment asked for by its waybill, in any letter case', () => {
    const payload = clone();
    payload[0]!.number = WAYBILL;
    payload[0]!.numberType = 'Shipment';
    expect(parseDhlEcommercePl(payload, WAYBILL).current_stage).toBe('delivered');
    const lower = clone();
    lower[0]!.number = NUMBER.toLowerCase();
    expect(parseDhlEcommercePl(lower, NUMBER).current_stage).toBe('delivered');
  });

  it('files an unrecorded code under its timeline step, without a time, and keeps the planned day', () => {
    const payload = clone();
    Object.assign(shipment(payload), { status: 'TT_LK', timelineStep: 'Delivery', step: '', title: 'Out with the courier',
      receiptDateUtc: null, planOfDeliveryFromUtc: '2026-03-04T23:30:00Z', planOfDeliveryToUtc: '2026-03-05T11:00:00Z' });
    const result = parseDhlEcommercePl(payload, NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: null, expected_delivery: '2026-03-05' });
    expect(result.delivered_at).toBeUndefined();
    expect(result).toMatchObject({ last_status_text: 'Out with the courier', summary_only: true, events: [] });
    expect(dhlEcommercePlStatus('TT_NEW_CODE', 'Route')).toEqual({ description: 'On its way', stage: 'in_transit' });
    expect(dhlEcommercePlStatus('TT_NEW_CODE', 'Somewhere')).toEqual({ description: 'Tt new code' });
    expect(dhlEcommercePlStatus('TT_NEW_CODE', 'None')).toEqual({ description: 'Shipment preparation' });
  });

  it('reads absence only from an entry without a number type', () => {
    expect(() => parseDhlEcommercePl([{ number: WAYBILL, shipments: [] }], WAYBILL)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDhlEcommercePl([{ number: WAYBILL, numberType: 'AllegroDelivery', shipments: [] }], WAYBILL))
      .toThrowError(expect.objectContaining({ kind: 'invalid_input', reason: 'other_carrier' }));
    expect(() => parseDhlEcommercePl([{ number: WAYBILL, numberType: 'Order', shipments: [] }], WAYBILL))
      .toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires the answer to name the requested number and one shipment', () => {
    const wrong = clone();
    wrong[0]!.number = 'JJD000039999999000000000001';
    expect(() => parseDhlEcommercePl(wrong, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommercePl([...clone(), ...clone()], NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommercePl({}, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const several = clone();
    several[0]!.shipments.push(structuredClone(several[0]!.shipments[0]!));
    expect(() => parseDhlEcommercePl(several, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    const codeless = clone();
    shipment(codeless).status = { code: 'TT_DOR' };
    expect(() => parseDhlEcommercePl(codeless, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a refusal of the number only from the portal\'s own error', () => {
    expect(() => parseDhlEcommercePlRejection({ errors: { number1: ['invalid'] }, code: 422 })).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => parseDhlEcommercePlRejection({ message: 'Unprocessable' })).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts what the portal\'s form takes and leaves Allegro Delivery numbers out', () => {
    expect(normalizeDhlEcommercePlNumber('jjd 0000 3999 9999 0000 0000 0000')).toBe(NUMBER);
    expect(normalizeDhlEcommercePlNumber(' 999-9999-9990 ')).toBe(WAYBILL);
    expect(() => normalizeDhlEcommercePlNumber('1234567890')).toThrow(InvalidInputError);
    expect(() => normalizeDhlEcommercePlNumber('9'.repeat(35))).toThrow(InvalidInputError);
    expect(() => normalizeDhlEcommercePlNumber('ABCDEFGHIJKL')).toThrow(InvalidInputError);
    expect(() => normalizeDhlEcommercePlNumber('AD000000000000000')).toThrowError(expect.objectContaining({ reason: 'other_carrier' }));
    expect(() => normalizeDhlEcommercePlNumber('AD00')).toThrowError(expect.objectContaining({ reason: undefined }));
  });

  it('gives every recorded code its wording and a known stage, and every recorded scan its stage', () => {
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      if ('code' in entry && entry.code) expect(dhlEcommercePlStatus(entry.code, 'Unknown')).toEqual({ description: entry.wording, stage: entry.stage });
      else {
        expect(dhlPolandScanStage(entry.wording), entry.wording).toBe(entry.stage);
        expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
      }
    }
  });
});

describe('DHL eCommerce Poland request challenge', () => {
  it('finds the number behind the challenge and returns it with the signed challenge', async () => {
    const task = parseDhlEcommercePlChallenge(challenge());
    const proof = await solveDhlEcommercePlChallenge(task, never, performance.now() + 10_000, 10_000);
    expect(JSON.parse(Buffer.from(proof, 'base64').toString())).toEqual({ algorithm: 'SHA-256', challenge: task.challenge,
      number: SECRET, salt: SALT, signature: task.signature });
  });

  it('gives up on a challenge without a solution, and stops when cancelled', async () => {
    const unsolvable = parseDhlEcommercePlChallenge(challenge(5_000, 3_000));
    await expect(solveDhlEcommercePlChallenge(unsolvable, never, performance.now() + 10_000, 10_000)).rejects.toMatchObject({ kind: 'indeterminate' });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(solveDhlEcommercePlChallenge(parseDhlEcommercePlChallenge(challenge(90_000)), cancelled.signal, performance.now() + 10_000, 10_000))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(solveDhlEcommercePlChallenge(parseDhlEcommercePlChallenge(challenge(90_000)), never, performance.now() - 1, 10_000))
      .rejects.toMatchObject({ kind: 'budget' });
  });

  it('refuses a challenge that is not the published form', () => {
    for (const change of [{ algorithm: 'SHA-512' }, { challenge: 'zz' }, { salt: 'not hex' }, { signature: 7 }, { maxnumber: 0 },
      { maxnumber: 1_000_001 }, { maxnumber: 1.5 }, { maxnumber: '100000' }]) {
      expect(() => parseDhlEcommercePlChallenge({ ...challenge(), ...change })).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDhlEcommercePlChallenge('<html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('DHL eCommerce Poland adapter', () => {
  it('restarts the read with a fresh proof after a connection failure and records recovery', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    let issued = 0;
    let lookedUp = 0;
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/auth/captcha/challenge')) return Response.json(challenge(++issued));
      if (++lookedUp === 1) throw new TypeError('Connection reset');
      return Response.json(clone());
    };
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DhlEcommercePlTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 5000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(issued).toBe(2);
    const proofs = requests.filter(row => row.init?.method === 'POST')
      .map(row => JSON.parse(String(row.init?.body))['captcha-payload']);
    expect(proofs[0]).not.toBe(proofs[1]);
    expect(recorder.step.mock.calls.map(([event]) => [event.step, event.outcome]))
      .toEqual([['direct', 'transport'], ['retry', 'ok']]);
  });

  it('keeps rate limits definitive and removes proof material from failed requests', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const error = await new DhlEcommercePlTracker({ fetcher: portal(() => new Response('refused', { status: 429 }), calls) })
      .fetch(NUMBER).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'rate_limited' });
    expect(calls).toHaveLength(2);
    expect((error as { request?: unknown }).request).toBeUndefined();
    expect((error as { diagnostics?: unknown }).diagnostics).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(SALT);
  });

  it('solves the challenge, asks for the one number and returns a normalized parcel', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const result = normalizeCarrierResult(await new DhlEcommercePlTracker({ fetcher: portal(() => Response.json(clone()), seen) }).fetch(NUMBER.toLowerCase()));
    expect(result.current_stage).toBe('delivered');
    expect(seen.map((request) => [request.init?.method ?? 'GET', request.url])).toEqual([
      ['GET', 'https://mojdhl.pl/api/dhl/public/auth/captcha/challenge'], ['POST', 'https://mojdhl.pl/api/dhl/public/shipment/status']]);
    expect(seen.every((request) => request.init?.signal)).toBe(true);
    const body = JSON.parse(String(seen[1]!.init?.body));
    expect(Object.keys(body)).toEqual(['number1', 'captcha-payload']);
    expect(body.number1).toBe(NUMBER);
    expect(JSON.parse(Buffer.from(body['captcha-payload'], 'base64').toString()).number).toBe(SECRET);
    expect(new Headers(seen[1]!.init?.headers).get('accept-language')).toBe('en');
  });

  it('recognizes a known parcel and an absent one', async () => {
    const known = adapter(environment(portal(() => Response.json(clone()))));
    await expect(known.recognize?.(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T09:15:00.000Z' });
    const unknown = adapter(environment(portal(() => Response.json([{ number: WAYBILL, shipments: [] }]))));
    await expect(unknown.recognize?.(WAYBILL)).resolves.toEqual({ known: false });
    await expect(unknown.track({ number: WAYBILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(unknown.recognize?.('AD000000000000000')).resolves.toEqual({ known: false });
  });

  it('never reads a refusal, a rejected proof or a block page as a missing parcel', async () => {
    const answers = (answer: () => Response) => adapter(environment(portal(answer))).track({ number: WAYBILL });
    await expect(answers(() => Response.json([{ number: WAYBILL, numberType: 'AllegroDelivery', shipments: [] }]))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(answers(() => Response.json({ errors: { number1: ['invalid'] }, code: 422 }, { status: 422 }))).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(answers(() => Response.json({ code: 400, message: 'Challenge has been verified before.' }, { status: 400 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(answers(() => new Response('<html><body>Request Rejected</body></html>', { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answers(() => new Response('<html>Unprocessable</html>', { status: 422 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(answers(() => Response.json([{ number: '99999999991', shipments: [] }]))).rejects.toMatchObject({ kind: 'schema' });
    await expect(answers(() => new Response('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('stops at a challenge it cannot use, before any lookup', async () => {
    let calls = 0;
    const issuing = (body: () => Response) => adapter(environment(async () => { calls += 1; return body(); })).track({ number: WAYBILL });
    await expect(issuing(() => Response.json({ ...challenge(), algorithm: 'SHA-1' }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(issuing(() => Response.json(challenge(5_000, 3_000)))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(issuing(() => new Response('<html>Request Rejected</html>'))).rejects.toMatchObject({ kind: 'challenge' });
    expect(calls).toBe(3);
  });
});


describe('DHL Poland optional history enrichment', () => {
  const endpoint = 'https://sprawdz.dhl.com.pl/';
  const history = { number: WAYBILL, events: [{ date: '04.03.2026', time: '10:15', location: 'Example depot', description: 'Delivered to customer.' }] };
  const capture = { url: endpoint, status: 200, trackingNumberSubmitted: WAYBILL, body: JSON.stringify(history) };
  const browser = (responses = [capture], requests: unknown[] = []) => new TrawlClient('https://browser.example.test', async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ success: true, tier: 2, statusCode: 200, html: '', capturedResponses: responses });
  });

  it('uses a validated waybill alias, enriches the summary and keeps HTTP recognition cheap', async () => {
    const requests: unknown[] = [];
    const client = adapter({ ...environment(portal(() => Response.json(clone()))), trawl: browser([capture], requests) });
    await expect(client.recognize?.(NUMBER)).resolves.toMatchObject({ known: true });
    expect(requests).toEqual([]);
    const result = await client.track({ number: NUMBER });
    expect(result).toMatchObject({ summary_only: false, current_stage: 'delivered', sender_name: 'Example Sender',
      last_update: '2026-03-04T09:15:00Z', delivered_at: '2026-03-04T09:15:00Z', events: [{ local_time: '2026-03-04T10:15:00' }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: `${endpoint}?sn=${WAYBILL}&lang=en-gb`, skipHttp: true, captureResponses: [endpoint] });
  });

  it('returns the already-confirmed summary with challenge provenance and no second proof', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new DhlEcommercePlTracker({ fetcher: portal(() => Response.json(clone()), calls), trawl: browser([]), recorder }).fetch(NUMBER);
    expect(result).toMatchObject({ summary_only: true, events: [], current_stage: 'delivered' });
    expect(calls).toHaveLength(2);
    expect(recorder.step.mock.calls.map(([event]) => [event.step, event.outcome, event.fallbackReason]))
      .toEqual([['trawl', 'challenge', null], ['direct', 'ok', 'challenge']]);
  });

  it('does not trust a history for another shipment or erase its schema failure', async () => {
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const trawl = browser([{ ...capture, body: JSON.stringify({ ...history, number: '99999999991' }) }]);
    const result = await new DhlEcommercePlTracker({ fetcher: portal(() => Response.json(clone())), trawl, recorder }).fetch(NUMBER);
    expect(result.summary_only).toBe(true);
    expect(result.events).toEqual([]);
    expect(recorder.step.mock.calls[1]?.[0]).toMatchObject({ step: 'direct', fallbackReason: 'schema' });
  });

  it('does not start the browser for absent, ambiguous or rejected HTTP identities', async () => {
    for (const payload of [[{ number: NUMBER, shipments: [] }], [...clone(), ...clone()], [{ ...clone()[0], number: '99999999991' }]]) {
      const requests: unknown[] = [];
      const tracker = new DhlEcommercePlTracker({ fetcher: portal(() => Response.json(payload)), trawl: browser([capture], requests) });
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: expect.stringMatching(/not_found|schema/) });
      expect(requests).toEqual([]);
    }
  });

  it('falls back inside a small budget without launching a browser request', async () => {
    const requests: unknown[] = [];
    const tracker = new DhlEcommercePlTracker({ fetcher: portal(() => Response.json(clone())), trawl: browser([capture], requests) });
    await expect(tracker.fetch(NUMBER, { budgetMs: 1000 })).resolves.toMatchObject({ summary_only: true });
    expect(requests).toEqual([]);
  });
});
