import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendsThrough } from '../../core/transport/transportOf.js';
import { DPD_DE_APP_API, DpdAppService, sharedDpdAppService, type DpdSession, type DpdSessionEvent } from './service.js';

// All credentials, sessions, shop ids and addresses here are invented.
const PARTNER = { name: 'Synthetic Partner', token: 'SYNTHETIC_TOKEN', password: 'SYNTHETIC_PASSWORD' };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/app-${name}.xml`, import.meta.url), 'utf8');
const xml = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
/** A Swiss shop's record: the service gives its street and town in capitals. */
const swissShop = () => xml(fixture('shop').replace('DE00001', 'CH00001').replace('Musterstr.', 'BEISPIELWEG')
  .replace('<ZipCode>00000</ZipCode>', '<ZipCode>0000</ZipCode>').replace('Musterstadt', 'BEISPIELDORF'));
/** The service's answer for a shop id no shop has: no error, and nothing confirmed. */
const unconfirmed = () => xml('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + '<getParcelShopByIDResponse xmlns="https://cloud.dpd.com/"><getParcelShopByIDResult><Ack>false</Ack><ErrorDataList />'
  + '</getParcelShopByIDResult></getParcelShopByIDResponse></soap:Body></soap:Envelope>');
const expired = () => xml('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + '<getParcelShopByIDResponse xmlns="https://cloud.dpd.com/"><getParcelShopByIDResult><Ack>false</Ack><ErrorDataList>'
  + '<ErrorData><ErrorID>1</ErrorID><ErrorCode>ERROR_SESSION_NOT_VALID</ErrorCode><ErrorMsg>Session</ErrorMsg></ErrorData>'
  + '</ErrorDataList></getParcelShopByIDResult></getParcelShopByIDResponse></soap:Body></soap:Envelope>');

interface Call { operation: string; body: string; signal?: AbortSignal | null }

const tokenOf = (call: Call | undefined) => /<SessionToken>([^<]*)</.exec(call?.body ?? '')?.[1];

/** Answers each operation from its queue for the session, then from its own, then with a session or the Swiss shop. */
function service(replies: Record<string, Array<() => Response | Promise<Response>>> = {}) {
  const calls: Call[] = [];
  const fetcher = ((url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(DPD_DE_APP_API);
    const operation = /^"https:\/\/cloud\.dpd\.com\/(\w+)"$/.exec(new Headers(init?.headers).get('SOAPAction') ?? '')?.[1] ?? '';
    const call = { operation, body: String(init?.body), signal: init?.signal };
    calls.push(call);
    const queued = replies[`${operation} ${tokenOf(call)}`]?.shift() ?? replies[operation]?.shift();
    if (queued) return Promise.resolve(queued());
    if (operation === 'getSessionFullState') return Promise.resolve(xml(fixture('session')));
    return operation === 'getParcelShopByID' ? Promise.resolve(swissShop()) : Promise.reject(new Error('Unexpected operation'));
  }) as typeof fetch;
  return { calls, fetcher, shops: new DpdAppService({ partner: PARTNER, fetcher }) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A session reply with its own token. */
const session = (token: string) => () => xml(fixture('session').replace(/<SessionToken>[^<]*/, `<SessionToken>${token}`));
const opened = (calls: Call[]) => calls.filter(call => call.operation === 'getSessionFullState').length;
const FIRST = 'U0VTU0lPTl9GSVJTVF9PTkU=';
const SECOND = 'U0VTU0lPTl9TRUNPTkRfT05F';

describe('DPD app service shop lookup', () => {
  it('reads a shop by its PUDO id, as the app asks for it', async () => {
    const { calls, shops } = service();
    await expect(shops.parcelShop('CH00001', { signal: new AbortController().signal, timeoutMs: 1_000 })).resolves.toEqual({
      name: 'Kiosk Muster', address: 'BEISPIELWEG 1\n0000 BEISPIELDORF',
    });
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID']);
    expect(calls[1]!.body).toContain('<ParcelShopID>0</ParcelShopID><PudoID>CH00001</PudoID><ParcelShopOnly>false</ParcelShopOnly>');
  });

  it('replaces an expired session once, then answers nothing', async () => {
    const signal = new AbortController().signal;
    const renewed = service({ getParcelShopByID: [expired] });
    await expect(renewed.shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 })).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(renewed.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID', 'getSessionFullState', 'getParcelShopByID']);
    const stuck = service({ getParcelShopByID: [expired, expired] });
    await expect(stuck.shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 })).resolves.toBeUndefined();
    expect(stuck.calls).toHaveLength(4);
  });

  it('answers nothing while the session opens, and keeps opening it for the next lookup', async () => {
    let open!: () => void;
    const { calls, shops } = service({ getSessionFullState: [() => new Promise<Response>((resolve) => { open = () => resolve(xml(fixture('session'))); })] });
    const signal = new AbortController().signal;
    await expect(shops.parcelShop('CH00001', { signal, timeoutMs: 1 })).resolves.toBeUndefined();
    expect(calls[0]!.signal?.aborted).toBe(false);
    open();
    await expect(shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 })).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(calls.filter(call => call.operation === 'getSessionFullState')).toHaveLength(1);
  });

  it('ends with its signal', async () => {
    const controller = new AbortController();
    const { shops } = service({ getParcelShopByID: [() => { controller.abort(new Error('Cancelled')); return xml('', 503); }] });
    await expect(shops.parcelShop('CH00001', { signal: controller.signal, timeoutMs: 1_000 })).rejects.toThrow('Cancelled');
  });
});

describe('DPD app service session', () => {
  afterEach(() => { vi.useRealTimers(); });
  const lookup = (shops: DpdAppService, signal = new AbortController().signal) => shops.parcelShop('CH00001', { signal, timeoutMs: 1_000 });

  it('keeps a session however old until the service refuses it', async () => {
    vi.useFakeTimers();
    const { calls, shops } = service({ getSessionFullState: [session(FIRST), session(SECOND)], getParcelShopByID: [swissShop, expired] });
    await lookup(shops);
    await vi.advanceTimersByTimeAsync(30 * DAY);
    await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(calls.map(call => [call.operation, tokenOf(call)])).toEqual([['getSessionFullState', ''], ['getParcelShopByID', FIRST],
      ['getParcelShopByID', FIRST], ['getSessionFullState', ''], ['getParcelShopByID', SECOND]]);
    // Without `keep`, nothing waits on a timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a session open without a lookup, and opens the next once the service refuses it', async () => {
    vi.useFakeTimers();
    let open!: () => void;
    const { calls, shops } = service({ getSessionFullState: [
      () => new Promise<Response>((resolve) => { open = () => resolve(session(FIRST)()); }),
      session(SECOND),
    ], getParcelShopByID: [swissShop, expired] });
    shops.keep();
    expect(opened(calls)).toBe(1);
    // A lookup that stops waiting leaves the opening running.
    const controller = new AbortController();
    const waiting = shops.parcelShop('CH00001', { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort(new Error('Cancelled'));
    await expect(waiting).rejects.toThrow('Cancelled');
    expect(calls[0]!.signal?.aborted).toBe(false);
    open();
    await vi.advanceTimersByTimeAsync(0);
    await lookup(shops);
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID']);
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(opened(calls)).toBe(1);
    await lookup(shops);
    expect(opened(calls)).toBe(2);
    expect(tokenOf(calls.at(-1))).toBe(SECOND);
    // Without a store, no session is checked, and nothing waits on a timer.
    expect(calls.filter(call => call.operation === 'getParcelShopByID')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tries a kept session again a quarter of an hour after a failed opening', async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const { calls, shops } = service({ getSessionFullState: [() => xml('', 503)] });
    shops.keep();
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(opened(calls)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened(calls)).toBe(2);
    await lookup(shops);
    expect(calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getSessionFullState', 'getParcelShopByID']);
    // The retry timer never holds the process open.
    const retries = timers.mock.calls.flatMap(([, ms], index) => ms === 15 * MINUTE
      ? [timers.mock.results[index]!.value as ReturnType<typeof setTimeout>] : []);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.hasRef()).toBe(false);
  });

  const SAVED = 'U0FWRURfU0VTU0lPTl9PTkU=';
  const OLDER = 'T0xERVJfU0VTU0lPTl9PTkU=';
  const FIXTURE = 'U1lOVEhFVElDX1NFU1NJT05fMDAwMQ==';
  /** A host's store, holding these sessions. */
  const memory = (sessions: DpdSession[] = []) => {
    const saves: DpdSession[] = [];
    return { saves, store: { load: vi.fn(async () => sessions), save: vi.fn(async (session: DpdSession) => { saves.push(session); }) } };
  };
  const checks = (calls: Call[], token?: string) => calls.filter(call => call.body.includes('<PudoID>XX0000</PudoID>'))
    .map(tokenOf).filter(checked => !token || checked === token);
  const savesOf = (saves: DpdSession[], token: string) => saves.filter(saved => saved.token === token);

  it('takes up the newest saved session after a restart, whatever its age, and checks it every hour', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service();
    const { saves, store } = memory([{ token: OLDER, openedAt: start - 31 * DAY }, { token: SAVED, openedAt: start - 30 * DAY, checkedAt: start - 20 * MINUTE }]);
    shops.keep({ store });
    // A lookup waits for the store rather than opening a session of its own.
    await lookup(shops);
    expect(tokenOf(calls.at(-1))).toBe(SAVED);
    // Its next check is an hour after its last; an older one is checked for a week after it opened.
    await vi.advanceTimersByTimeAsync(40 * MINUTE - 1);
    expect(checks(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks(calls)).toEqual([SAVED]);
    expect(saves).toEqual([{ token: SAVED, openedAt: start - 30 * DAY, checkedAt: start + 40 * MINUTE }]);
    // It is checked for as long as the service accepts it.
    await vi.advanceTimersByTimeAsync(30 * DAY);
    expect(checks(calls)).toEqual(Array(30 * 24 + 1).fill(SAVED));
    expect(opened(calls)).toBe(0);
  });

  it('opens the next session once a check finds the current one refused, and saves the refusal the next check repeats', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service({ [`getParcelShopByID ${SAVED}`]: [expired, expired] });
    const { saves, store } = memory([{ token: SAVED, openedAt: start - 3 * DAY, checkedAt: start - HOUR }]);
    shops.keep({ store });
    await vi.advanceTimersByTimeAsync(0);
    expect(checks(calls)).toEqual([SAVED]);
    expect(opened(calls)).toBe(1);
    await lookup(shops);
    expect(tokenOf(calls.at(-1))).toBe(FIXTURE);
    await vi.advanceTimersByTimeAsync(HOUR + 5_000);
    expect(checks(calls)).toEqual([SAVED, SAVED, FIXTURE]);
    expect(savesOf(saves, SAVED)).toEqual([{ token: SAVED, openedAt: start - 3 * DAY, checkedAt: start - HOUR, refusedAt: start }]);
    expect(savesOf(saves, FIXTURE)).toEqual([{ token: FIXTURE, openedAt: start }, { token: FIXTURE, openedAt: start, checkedAt: start + HOUR + 5_000 }]);
  });

  it('checks a session no longer used every hour until the service refuses it twice, and saves what it finds', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service({ [`getParcelShopByID ${SAVED}`]: [unconfirmed, expired, unconfirmed, () => xml('', 503), expired, expired] });
    const { saves, store } = memory([{ token: OLDER, openedAt: start - HOUR, checkedAt: start },
      { token: SAVED, openedAt: start - 9 * HOUR, checkedAt: start - 40 * MINUTE }]);
    shops.keep({ store });
    await vi.advanceTimersByTimeAsync(0);
    // The newest is taken up, and the older one followed.
    expect(opened(calls)).toBe(0);
    // Its next check is an hour after the one saved before the restart, however recent the restart.
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(checks(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks(calls)).toEqual([SAVED]);
    const first = start + 20 * MINUTE;
    expect(saves.at(-1)).toEqual({ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: first });
    // One refusal is not enough: while slow, the service refuses a session it accepts again later.
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(savesOf(saves, SAVED).at(-1)).toEqual({ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: first + 2 * HOUR });
    // A reply that is not about the session says nothing.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(savesOf(saves, SAVED)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(savesOf(saves, SAVED).at(-1)).toEqual({ token: SAVED, openedAt: start - 9 * HOUR, checkedAt: first + 2 * HOUR, refusedAt: first + 4 * HOUR });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(checks(calls, SAVED)).toHaveLength(6);
    // The current one, accepted throughout, stays.
    expect(opened(calls)).toBe(0);
  });

  it('follows a session the service refused during a lookup, and checks several sessions apart', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { calls, shops } = service({ getSessionFullState: [session(SAVED)], getParcelShopByID: [expired] });
    const { saves, store } = memory([{ token: OLDER, openedAt: start - 20 * HOUR, checkedAt: start }]);
    shops.keep({ store });
    await vi.advanceTimersByTimeAsync(0);
    await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(opened(calls)).toBe(1);
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(checks(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(checks(calls)).toEqual([OLDER]);
    // The swiss shop answers the check: the service accepts the refused session after all.
    expect(saves.at(-1)).toEqual({ token: OLDER, openedAt: start - 20 * HOUR, checkedAt: start + HOUR });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checks(calls)).toEqual([OLDER, SAVED]);
    expect(saves.at(-1)).toEqual({ token: SAVED, openedAt: start, checkedAt: start + HOUR + 5_000 });
  });

  it('opens a session as before when the store fails, answers late or cannot save', async () => {
    vi.useFakeTimers();
    const failing = service();
    failing.shops.keep({ store: { load: () => Promise.reject(new Error('Unavailable')), save: () => Promise.reject(new Error('Unavailable')) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened(failing.calls)).toBe(1);
    const late = service();
    late.shops.keep({ store: { load: () => new Promise<never>(() => {}), save: () => { throw new Error('Unavailable'); } } });
    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(opened(late.calls)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened(late.calls)).toBe(1);
    await lookup(late.shops);
    expect(late.calls.map(call => call.operation)).toEqual(['getSessionFullState', 'getParcelShopByID']);
    // A lookup that stops waiting for the store ends with its signal.
    const waiting = service();
    waiting.shops.keep({ store: { load: () => new Promise<never>(() => {}), save: async () => {} } });
    const controller = new AbortController();
    const pending = waiting.shops.parcelShop('CH00001', { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort(new Error('Cancelled'));
    await expect(pending).rejects.toThrow('Cancelled');
  });

  /** A host's observer, which keeps what it hears. */
  const observer = () => {
    const events: DpdSessionEvent[] = [];
    return { events, onSession: (event: DpdSessionEvent) => { events.push(event); } };
  };
  const unreachable = () => Promise.reject(new TypeError('fetch failed'));

  it('tells the host how each opening ended, what began it and how long it took', async () => {
    vi.useFakeTimers();
    const { calls, shops } = service({ getSessionFullState: [
      () => new Promise<Response>((resolve) => { setTimeout(() => resolve(session(SAVED)()), 42_000); }),
      unreachable,
      session(OLDER),
    ], getParcelShopByID: [expired] });
    const { events, onSession } = observer();
    shops.keep({ onSession });
    await vi.advanceTimersByTimeAsync(42_000);
    expect(events).toEqual([{ outcome: 'opened', trigger: 'start', durationMs: 42_000 }]);
    await expect(lookup(shops)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toEqual({ outcome: 'failed', trigger: 'refused', durationMs: 0, errorKind: 'transport' });
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(events.at(-1)).toEqual({ outcome: 'opened', trigger: 'retry', durationMs: 0 });
    expect(opened(calls)).toBe(3);
    // The tokens stay with the service.
    expect(JSON.stringify(events)).not.toMatch(new RegExp(`${SAVED}|${OLDER}|${FIXTURE}`.replace(/[+=]/g, '\\$&')));
  });

  it('tells the host of a session taken up at start, and of one opened after a refusal or for a lookup', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { shops } = service({ getParcelShopByID: [expired] });
    const { store } = memory([{ token: SAVED, openedAt: start - 2 * HOUR }]);
    const { events, onSession } = observer();
    shops.keep({ store: { ...store, load: () => new Promise(resolve => { setTimeout(() => resolve(store.load()), 300); }) }, onSession });
    await vi.advanceTimersByTimeAsync(300);
    expect(events).toEqual([{ outcome: 'taken_up', trigger: 'start', durationMs: 300, ageMs: 2 * HOUR + 300 }]);
    // The service refuses the session taken up: the lookup opens the next one.
    await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(events.at(-1)).toEqual({ outcome: 'opened', trigger: 'refused', durationMs: 0 });
    // A lookup that finds no session open after a failed opening opens one itself.
    const failed = service({ getSessionFullState: [unreachable] });
    const heard = observer();
    failed.shops.keep({ onSession: heard.onSession });
    await vi.advanceTimersByTimeAsync(0);
    await expect(lookup(failed.shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
    expect(heard.events).toEqual([
      { outcome: 'failed', trigger: 'start', durationMs: 0, errorKind: 'transport' },
      { outcome: 'opened', trigger: 'lookup', durationMs: 0 },
    ]);
  });

  it('keeps lookups and openings going when the observer fails', async () => {
    vi.useFakeTimers();
    for (const onSession of [() => { throw new Error('Observer failed'); }, () => Promise.reject(new Error('Observer failed'))]) {
      const { calls, shops } = service({ getSessionFullState: [unreachable], getParcelShopByID: [swissShop, expired] });
      shops.keep({ onSession });
      await vi.advanceTimersByTimeAsync(0);
      await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
      await expect(lookup(shops)).resolves.toMatchObject({ name: 'Kiosk Muster' });
      expect(opened(calls)).toBe(3);
    }
  });

  it('is one per transport and user agent in the process', () => {
    const { fetcher } = service();
    expect(sharedDpdAppService({ fetcher })).toBe(sharedDpdAppService({ fetcher, userAgent: undefined }));
    expect(sharedDpdAppService({ fetcher })).not.toBe(sharedDpdAppService({ fetcher: service().fetcher }));
    expect(sharedDpdAppService({ fetcher })).not.toBe(sharedDpdAppService({ fetcher, userAgent: 'Host/1.0' }));
  });

  it('is the one of the fetcher under a tracker\'s wrapper', () => {
    const { fetcher } = service();
    const wrapper = sendsThrough((url, init) => fetcher(url, init), fetcher);
    expect(sharedDpdAppService({ fetcher: wrapper })).toBe(sharedDpdAppService({ fetcher }));
    const global = sendsThrough((url, init) => fetch(url, init), undefined);
    expect(sharedDpdAppService({ fetcher: global })).toBe(sharedDpdAppService());
    expect(sharedDpdAppService({ fetcher: (url, init) => fetcher(url, init) })).not.toBe(sharedDpdAppService({ fetcher }));
  });
});
