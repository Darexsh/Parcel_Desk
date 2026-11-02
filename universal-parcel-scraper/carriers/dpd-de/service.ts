import { createHash, randomBytes } from 'node:crypto';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, errorTypeOf, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { isRecord } from '../../core/types.js';

// The German DPD app's SOAP service, shared between carriers. DPD Germany tracks parcels
// through it, and DPD Switzerland reads the address of the Pickup shop holding a parcel
// from it: `getParcelShopByID` answers for the group's shops, Swiss ones included.

export const DPD_DE_APP_API = 'https://api.paketnavigator.de/services/v1/Navigator3Service.asmx';
/** The lookup stopped waiting for the session, which keeps opening for the next one. */
export const DPD_DE_SESSION_OPENING = 'session_opening';
/** Activity either German tier places outside Germany. */
export const DPD_DE_OTHER_COUNTRY = 'other_country';

/** A parcel DPD's group places in another country: `country` is the code the tier gave for where it is now. */
export class DpdOtherCountryError extends IndeterminateError {
  constructor(readonly country: string) {
    super('DPD Germany', 'DPD returned activity in another country', { reason: DPD_DE_OTHER_COUNTRY });
  }
}
const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const SERVICE = 'https://cloud.dpd.com/';
const MAX_BYTES = 2_000_000;
/** Opening a session has taken up to 75 seconds. */
const SESSION_OPEN_MS = 120_000;
/** A kept session that failed to open is tried again after this long. */
const SESSION_RETRY_MS = 15 * 60_000;
/** A host's store has this long to give back its sessions before the service opens one. */
const STORE_LOAD_MS = 5_000;
/**
 * With a store, the current session and those lookups no longer use are checked once they were
 * last asked about this long ago, counting a check saved before a restart. One no longer used is
 * checked until the service refuses it twice in a row: while slow, it can refuse a session it
 * accepts again later.
 */
const CHECK_EVERY_MS = 3_600_000;
/** One lookups no longer use is checked for at most this long after it opened, unless a refusal waits for the next check. */
const CHECK_FOR_MS = 7 * 24 * 3_600_000;
/** A check takes a fraction of a second, and checks of several sessions are this far apart. */
const CHECK_TIMEOUT_MS = 30_000;
const CHECK_GAP_MS = 5_000;
/** A shop id no shop has: the service answers it without a shop, or refuses the session. */
const CHECK_PUDO_ID = 'XX0000';
const TOKEN = /^[A-Za-z0-9+/=]{16,512}$/;
// Shared partner credentials of the public app, distributed with the maintainer's approval.
const PARTNER: DpdDePartner = { name: 'Android Paketnavigator3', token: 'A33363237662F5945576', password: '272 WetFd2mpXrgD' };

export interface DpdDePartner { name: string; token: string; password: string }

export function invalid(): never { throw new SchemaError('DPD Germany', 'DPD Germany returned invalid tracking XML'); }

export function children(node: XmlNode, name: string, uri = SERVICE): XmlNode[] {
  return node.children.filter(child => child.name === name && child.uri === uri);
}

export function one(node: XmlNode, name: string, uri = SERVICE): XmlNode {
  const matches = children(node, name, uri);
  return matches.length === 1 ? matches[0]! : invalid();
}

export function scalar(node: XmlNode, name: string, max = 200): string {
  const matches = children(node, name);
  if (matches.length > 1 || matches[0]?.children.length) invalid();
  return clean(matches[0]?.text ?? '', max);
}

export function optional(node: XmlNode, name: string): XmlNode | undefined {
  const matches = children(node, name);
  if (matches.length > 1) invalid();
  return matches[0];
}

const escaped = (value: string) => value.replace(/[<>&"']/g, character => `&#${character.charCodeAt(0)};`);

type Fields = { readonly [name: string]: string | Fields };
const elements = (fields: Fields): string => Object.entries(fields)
  .map(([name, value]) => `<${name}>${typeof value === 'string' ? escaped(value) : elements(value)}</${name}>`).join('');

/** The service no longer accepts the session. */
export class SessionExpired extends Error {}
/** DPD does not hold the postcode to be the recipient's. */
export class PostcodeRejected extends Error {}
/** The service took the session, but confirmed nothing. */
class Unconfirmed extends IndeterminateError {}

/** A Pickup shop as its own record names it: its name, then its street and its town on a line each. */
export interface DpdParcelShop { name: string; address: string }

/** The shop that `getParcelShopByID` returns, if it is the requested one and has a street and a town. */
function shopOf(result: XmlNode, id: string): DpdParcelShop | undefined {
  const shop = one(result, 'ParcelShop');
  if (scalar(shop, 'PUDOID', 40) !== id) return undefined;
  const address = one(shop, 'ShopAddress');
  const street = scalar(address, 'Street', 120);
  const city = scalar(address, 'City', 80);
  if (!street || !city) return undefined;
  return {
    name: scalar(address, 'Company', 120),
    address: `${[street, scalar(address, 'HouseNo', 20)].filter(Boolean).join(' ')}\n${[scalar(address, 'ZipCode', 16), city].filter(Boolean).join(' ')}`,
  };
}

interface Opening { token: Promise<string>; holders: Set<AbortSignal>; release: () => void }

/** A session as a host keeps it between processes. Times are milliseconds since the epoch. */
export interface DpdSession {
  token: string;
  openedAt: number;
  /** The last time an hourly check found the service accepting it. */
  checkedAt?: number;
  /** When the service began refusing it, once a second check confirmed it. */
  refusedAt?: number;
}

/**
 * Where a long-lived host keeps the sessions, so that a restart takes the current one up again
 * instead of opening another, and so that how long the service accepts one can be read back:
 * `refusedAt - openedAt` once it refused it, and `checkedAt - openedAt` until then. The service
 * carries on without a store that fails.
 */
export interface DpdSessionStore {
  /** The sessions saved that the service has not refused, in any order, the newest whatever its age. */
  load(): Promise<readonly DpdSession[]>;
  /** Saves a session, replacing what was saved for the same token. */
  save(session: DpdSession): Promise<void>;
}

/**
 * What a long-lived host learns of the sessions the service keeps, without their tokens: a
 * session taken up from the store at start, and each opening once it ends, whatever began it.
 */
export interface DpdSessionEvent {
  outcome: 'taken_up' | 'opened' | 'failed';
  /**
   * What began the opening: `start` when the host kept the service, `retry` a quarter of an hour
   * after a failed opening, `refused` when a lookup or a check found the service refusing the
   * session, and `lookup` when a lookup found none open. A session taken up is always `start`.
   */
  trigger: 'start' | 'retry' | 'refused' | 'lookup';
  /** How long the opening took, or the store's load for a session taken up. */
  durationMs: number;
  /** For a session taken up: how long ago it opened. */
  ageMs?: number;
  /** For a failure: its error kind, such as `transport` or `schema`, else its class name. */
  errorKind?: string;
}

/** What `keep` takes, as `warmDpdSession` does. */
interface KeepOptions {
  store?: DpdSessionStore;
  /** Told of each session taken up or opening that ends. It is called apart from lookups, and what it throws or rejects is ignored. */
  onSession?: (event: DpdSessionEvent) => void | Promise<void>;
}

/** A session the service is asked about: the current one, or one lookups no longer use until the service refuses it. */
interface Followed { session: DpdSession; askedAt: number; refusedSince?: number }

/** The promise's outcome, or the signal's reason once it aborts first. */
async function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let leave!: () => void;
  const left = new Promise<never>((_resolve, reject) => { leave = () => reject(signal.reason as Error); });
  signal.addEventListener('abort', leave, { once: true });
  try { return await Promise.race([promise, left]); }
  finally { signal.removeEventListener('abort', leave); }
}

/**
 * The service needs an anonymous device session, which it takes tens of seconds to open and then
 * accepts for days: it has accepted one for over two days, and refused another at twenty-seven
 * hours old, in two checks an hour apart, though it accepted others for longer. One is kept per
 * instance until the service refuses it, and `sharedDpdAppService` gives the process one instance
 * per transport. The opening runs on its own clock, so a lookup that stops waiting leaves it to
 * the next.
 */
export class DpdAppService {
  readonly #partner: DpdDePartner;
  readonly #fetcher?: typeof fetch;
  readonly #userAgent: string;
  readonly #now: () => number;
  readonly #device = randomBytes(8).toString('hex');
  #session: { token: string; openedAt: number } | null = null;
  #opening: Opening | null = null;
  #kept = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #store: DpdSessionStore | undefined;
  #onSession: KeepOptions['onSession'];
  /** The service refused the last session, and none has opened since. */
  #refused = false;
  #loading: Promise<void> | null = null;
  readonly #followed = new Map<string, Followed>();

  constructor(options: { partner?: DpdDePartner; fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {
    this.#partner = options.partner ?? PARTNER;
    this.#fetcher = options.fetcher;
    this.#userAgent = userAgentOf(options.userAgent);
    this.#now = options.now ?? Date.now;
  }

  /**
   * The Pickup shop with this PUDO id, or nothing when the service does not answer it within
   * `timeoutMs`, including the wait for a session. Only the signal ends it with an error.
   */
  async parcelShop(id: string, options: { signal: AbortSignal; timeoutMs: number }): Promise<DpdParcelShop | undefined> {
    const deadline = performance.now() + options.timeoutMs;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    try {
      for (let attempt = 0; ; attempt += 1) {
        const session = await this.session(options.signal, left());
        try {
          return shopOf(await this.call('getParcelShopByID', { SessionToken: session, ParcelShopID: '0', PudoID: id,
            ParcelShopOnly: 'false' }, options.signal, left()), id);
        } catch (error) {
          if (!(error instanceof SessionExpired) || attempt) throw error;
          this.expire(session);
        }
      }
    } catch {
      options.signal.throwIfAborted();
      return undefined;
    }
  }

  /** Whether no session is open, as while one opens or a host's store gives back its sessions. */
  get opening(): boolean {
    return this.#session === null;
  }

  /** Forgets a session the service refused, unless another lookup already replaced it. */
  expire(session: string): void {
    if (this.#session?.token !== session) return;
    this.#track(this.#session, this.#now());
    this.#session = null;
    this.#refused = true;
  }

  /**
   * Keeps a session open from now on, for a long-lived host: one opens at once if there is none,
   * and the next once the service refuses it. Openings then run whether or not a lookup waits
   * for them. With a store, the newest session saved there is taken up again instead, whatever
   * its age, and checked every hour, so that a refusal opens the next one before a lookup meets
   * it. The sessions lookups no longer use are checked until the service refuses them.
   * `onSession` hears of each session taken up or opening that ends. The timers do not keep the
   * process alive. Only the first call counts.
   */
  keep(options: KeepOptions = {}): void {
    if (this.#kept) return;
    this.#kept = true;
    const { store, onSession } = options;
    this.#store = store;
    this.#onSession = onSession;
    if (!store) return this.#ensure('start');
    this.#loading = this.#load(store).finally(() => {
      this.#loading = null;
      this.#ensure('start');
      this.#follow();
    });
  }

  /** Tells the host's observer, if there is one, apart from the lookup and whatever it does. */
  #report(event: DpdSessionEvent): void {
    const observer = this.#onSession;
    if (observer) void Promise.resolve().then(() => observer(event)).catch(() => undefined);
  }

  /** Takes up the newest saved session, and follows it and the others under a week old. */
  async #load(store: DpdSessionStore): Promise<void> {
    const started = this.#now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The store did not answer')), STORE_LOAD_MS); });
    let saved: readonly DpdSession[];
    try { saved = await Promise.race([Promise.resolve().then(() => store.load()), late]); }
    catch { return; }
    finally { clearTimeout(timer); }
    const now = this.#now();
    const sessions = (Array.isArray(saved) ? saved as readonly unknown[] : [])
      .filter((session): session is DpdSession => isRecord(session) && typeof session.token === 'string' && TOKEN.test(session.token)
        && typeof session.openedAt === 'number' && session.openedAt <= now && session.refusedAt == null)
      .sort((left, right) => right.openedAt - left.openedAt);
    const [newest] = sessions;
    if (newest && !this.#session) {
      this.#session = { token: newest.token, openedAt: newest.openedAt };
      this.#report({ outcome: 'taken_up', trigger: 'start', durationMs: Math.max(0, now - started), ageMs: now - newest.openedAt });
    }
    for (const session of sessions) {
      if (session.token !== this.#session?.token && now - session.openedAt >= CHECK_FOR_MS) continue;
      this.#followed.set(session.token, { session: { ...session }, askedAt: session.checkedAt ?? session.openedAt });
    }
    if (this.#session) this.#track(this.#session);
  }

  /** Saves a session's state in the host's store, if there is one, without waiting for it. */
  #save(session: DpdSession): void {
    const store = this.#store;
    if (store) void Promise.resolve().then(() => store.save({ ...session })).catch(() => undefined);
  }

  /**
   * Follows a session when a store keeps what its checks find. One the service refused is checked
   * an hour after the refusal, which counts once that check repeats it.
   */
  #track(session: { token: string; openedAt: number }, refusedAt?: number): void {
    if (!this.#store) return;
    const followed = this.#followed.get(session.token);
    if (!followed) this.#followed.set(session.token, { session: { ...session }, askedAt: this.#now(), refusedSince: refusedAt });
    else if (refusedAt !== undefined && followed.refusedSince === undefined) {
      followed.askedAt = this.#now();
      followed.refusedSince = refusedAt;
    }
  }

  /** Checks the sessions followed when the first of them is due. */
  #follow(): void {
    let due = this.#now() + CHECK_EVERY_MS;
    for (const followed of this.#followed.values()) due = Math.min(due, followed.askedAt + CHECK_EVERY_MS);
    const timer = setTimeout(() => void this.#check().finally(() => this.#follow()), Math.max(0, due - this.#now()));
    timer.unref?.();
  }

  /**
   * Asks the service once for each followed session that is due whether it still accepts it. A
   * refusal of the current session opens the next one at once. A refusal confirmed by the next
   * check is saved as the time it began; a reply that is not about the session says nothing.
   */
  async #check(): Promise<void> {
    let first = true;
    for (const [token, followed] of [...this.#followed]) {
      const now = this.#now();
      if (token !== this.#session?.token && followed.refusedSince === undefined && now - followed.session.openedAt >= CHECK_FOR_MS) {
        this.#followed.delete(token);
        continue;
      }
      if (now - followed.askedAt < CHECK_EVERY_MS) continue;
      if (!first) await new Promise<void>((resolve) => { setTimeout(resolve, CHECK_GAP_MS).unref?.(); });
      first = false;
      followed.askedAt = this.#now();
      let accepted: boolean;
      try {
        await this.call('getParcelShopByID', { SessionToken: token, ParcelShopID: '0', PudoID: CHECK_PUDO_ID, ParcelShopOnly: 'false' },
          AbortSignal.timeout(CHECK_TIMEOUT_MS), CHECK_TIMEOUT_MS);
        accepted = true;
      } catch (error) {
        if (error instanceof SessionExpired) accepted = false;
        else if (error instanceof Unconfirmed) accepted = true;
        else continue;
      }
      if (accepted) {
        followed.refusedSince = undefined;
        followed.session.checkedAt = this.#now();
        this.#save(followed.session);
      } else if (followed.refusedSince === undefined) {
        followed.refusedSince = this.#now();
        if (this.#session?.token === token) {
          this.expire(token);
          this.#ensure('refused');
        }
      } else {
        followed.session.refusedAt = followed.refusedSince;
        this.#followed.delete(token);
        this.#save(followed.session);
      }
    }
  }

  /** Opens a session if none is open or opening. */
  #ensure(trigger: DpdSessionEvent['trigger']): void {
    if (!this.#session && !this.#opening) this.#opening = this.#open(trigger);
  }

  /** Tries a kept service's opening again a quarter of an hour after one failed. */
  #retry(): void {
    if (!this.#kept) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#ensure('retry'), SESSION_RETRY_MS);
    this.#timer.unref?.();
  }

  /** An opening, which a kept service finishes and otherwise ends when no lookup holds it. */
  #open(trigger: DpdSessionEvent['trigger']): Opening {
    const started = this.#now();
    const controller = new AbortController();
    const holders = new Set<AbortSignal>();
    const token = this.call('getSessionFullState', { SessionToken: '', DeviceData: {
      HardwareID: this.#device, BootSystemID: 'Android_Phone', Version: '15', AppVersion: '4.2.0',
    } }, controller.signal, SESSION_OPEN_MS).then(result => {
      const value = scalar(one(result, 'SessionFullState'), 'SessionToken', 600);
      if (!TOKEN.test(value)) invalid();
      if (this.#session) this.#track(this.#session);
      this.#session = { token: value, openedAt: this.#now() };
      this.#refused = false;
      this.#track(this.#session);
      this.#save(this.#session);
      return value;
    });
    const release = () => {
      for (const holder of holders) if (holder.aborted) holders.delete(holder);
      if (!holders.size && !this.#kept) controller.abort(new Error('No lookup is waiting for the DPD Germany session'));
    };
    const opening = { token, holders, release };
    const durationMs = () => Math.max(0, this.#now() - started);
    void token.then(() => {
      this.#report({ outcome: 'opened', trigger, durationMs: durationMs() });
    }, (error: unknown) => {
      this.#report({ outcome: 'failed', trigger, durationMs: durationMs(), errorKind: carrierErrorKind(error) ?? errorTypeOf(error) });
      this.#retry();
    }).finally(() => {
      if (this.#opening === opening) this.#opening = null;
      for (const holder of holders) holder.removeEventListener('abort', release);
    });
    return opening;
  }

  /**
   * One session for every lookup. The opening runs while a lookup that asked for it is still
   * running, even one that stopped waiting; each lookup waits until its signal or `waitMs` ends.
   * `waiting` is called when the lookup starts waiting for an opening, once a host's store has
   * given back its sessions. A lookup whose `stop` aborts stops waiting with its reason, and still
   * holds the opening.
   */
  async session(signal: AbortSignal, waitMs: number, options: { waiting?: () => void; stop?: AbortSignal } = {}): Promise<string> {
    if (this.#loading) await until(this.#loading, signal);
    if (this.#session) return this.#session.token;
    signal.throwIfAborted();
    const opening = this.#opening ??= this.#open(this.#refused ? 'refused' : 'lookup');
    const { token, holders, release } = opening;
    if (!holders.has(signal)) {
      holders.add(signal);
      signal.addEventListener('abort', release, { once: true });
    }
    options.waiting?.();
    const ended = options.stop ? AbortSignal.any([signal, options.stop]) : signal;
    ended.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new IndeterminateError('DPD Germany', 'DPD Germany app session is still opening', {
        reason: DPD_DE_SESSION_OPENING,
      })), Math.max(0, Math.min(waitMs, SESSION_OPEN_MS)));
    });
    try { return await until(Promise.race([token, late]), ended); }
    finally { clearTimeout(timer); }
  }

  async call(operation: string, fields: Fields, signal: AbortSignal, timeoutMs: number): Promise<XmlNode> {
    // The service checks a key derived from the minute of the UTC day.
    const now = new Date(this.#now());
    const phase = String((now.getUTCHours() * 60 + now.getUTCMinutes() + 1000) * 3);
    const key = phase + createHash('md5').update(`${phase}${this.#partner.name}0${operation}${this.#partner.password}`).digest('base64').slice(0, 16);
    const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${SOAP}"><soap:Body><${operation} xmlns="${SERVICE}"><${operation}Request>${elements({
      Version: '100', Language: 'de_EN', PartnerCredentials: { Name: this.#partner.name, Token: this.#partner.token, KeyPhase: key }, ...fields,
    })}</${operation}Request></${operation}></soap:Body></soap:Envelope>`;
    const { response, bytes } = await fetchBounded(DPD_DE_APP_API, { method: 'POST', signal, body,
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${SERVICE}${operation}"`, Accept: 'text/xml', 'User-Agent': this.#userAgent } }, {
      provider: 'DPD Germany', maxBytes: MAX_BYTES, timeoutMs, fetcher: this.#fetcher, allowHttpStatuses: [404, 410],
    });
    if (response.status !== 200) throw new TransportError('DPD Germany', 'DPD Germany app service is unavailable', { status: response.status });
    const root = xmlDocument(decodeText(bytes), MAX_BYTES) ?? invalid();
    if (root.name !== 'Envelope' || root.uri !== SOAP) invalid();
    const result = one(one(one(root, 'Body', SOAP), `${operation}Response`), `${operation}Result`);
    const codes = children(result, 'ErrorDataList').flatMap(list => children(list, 'ErrorData')).map(error => scalar(error, 'ErrorCode', 80));
    if (codes.some(code => code === 'ERROR_PARTNER' || code === 'ERROR_KEYPHASE')) {
      throw new ChallengeError('DPD Germany', 'DPD Germany refused the app credential');
    }
    if (codes.includes('ERROR_SESSION_NOT_VALID')) throw new SessionExpired();
    if (codes.includes('ERROR_TRACKING_DELIVERYZIPCODE_NOT_VALID')) throw new PostcodeRejected();
    // "No tracking data" also answers for parcels the scan list still knows: it proves no absence.
    if (scalar(result, 'Ack', 8) !== 'true') throw new Unconfirmed('DPD Germany', 'DPD Germany returned no confirmed parcel');
    return result;
  }
}

const services = new WeakMap<object, Map<string, DpdAppService>>();
const GLOBAL_FETCH = {};

/**
 * The process's service for a transport and user agent. DPD Germany and DPD Switzerland share it,
 * and so do the adapters of every registry and tracker, so a session opens once for all of them.
 * A tracker's wrapper only adds each lookup's signal, so the service is that of the fetcher under it.
 */
export function sharedDpdAppService(options: Pick<AdapterEnvironment, 'fetcher' | 'userAgent'> = {}): DpdAppService {
  const userAgent = userAgentOf(options.userAgent);
  const fetcher = transportOf(options.fetcher);
  const key = fetcher ?? GLOBAL_FETCH;
  let byAgent = services.get(key);
  if (!byAgent) services.set(key, byAgent = new Map<string, DpdAppService>());
  let service = byAgent.get(userAgent);
  if (!service) byAgent.set(userAgent, service = new DpdAppService({ fetcher, userAgent }));
  return service;
}

/**
 * Opens the session DPD Germany and DPD Switzerland read the German DPD app's service with, in the
 * background, and keeps one open for the life of the process, so that no lookup waits the tens of
 * seconds an opening takes. For a long-lived host, with the `fetcher` and `userAgent` it gives
 * `createTracker` or its adapter environment. With a `store`, a restart takes the newest saved
 * session up again, and the sessions are checked every hour, also across restarts: the current
 * one, which a refusal replaces at once, and the ones no longer used until the service refuses
 * them, which the store records. `onSession` hears of each session taken up and each opening that
 * ends, so the host can tell how long openings take and when one fails. The timers do not keep
 * the process alive.
 */
export function warmDpdSession(environment: Pick<AdapterEnvironment, 'fetcher' | 'userAgent'> = {},
  options: { store?: DpdSessionStore; onSession?: (event: DpdSessionEvent) => void | Promise<void> } = {}): void {
  sharedDpdAppService(environment).keep(options);
}
