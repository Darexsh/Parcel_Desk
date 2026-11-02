
import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { sfExpressEventStatus, sfExpressSummaryStatus } from './status.js';

const PROVIDER = 'SF Express';
const MAX_EVENTS = 100;

export function normalizeSfExpressNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^(?:SF\d{13}|\d{12})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'SF Express requires a 12-digit number or SF followed by 13 digits');
  }
  return number;
}

// The clock of every scan this route query returns, wherever its site is:
// UTC+08:00, the time of mainland China, Hong Kong, Macau and Taiwan, none of
// which keeps daylight saving. SF's international history, which gives each
// scan its offset, places the scans of its sites abroad at the instants these
// clocks give on UTC+08:00, not on the sites' own clocks, and flights only take
// a plausible time on that reading.
const CLOCK_ZONE = 'UTC+8';

/** A scan's wall clock, as an offset-less ISO string, and its instant on the query's clock. */
function scanTime(raw: unknown): { local: string; time: string } {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    throw new SchemaError(PROVIDER, 'SF Express returned an invalid scan date');
  }
  // UTC here only validates calendar components.
  const parsed = DateTime.fromFormat(raw, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  const local = parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : '';
  const time = local ? isoTime(local, CLOCK_ZONE)?.iso : undefined;
  if (!time) throw new SchemaError(PROVIDER, 'SF Express returned an invalid scan date');
  return { local, time };
}

function remarkText(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 10_000) throw new SchemaError(PROVIDER, 'SF Express returned an invalid scan remark');
  const $ = load(raw, null, false);
  $('script, style, iframe, img, input, button, [id="opr_phone"], .route-phone, a[href^="tel:"]').remove();
  return clean($.root().text(), 1_000);
}

// The English remarks name some sites in Chinese with their English name in
// brackets after it, as 【<Chinese>（<English>）】. The English name stays.
const BILINGUAL_SITE = /【([^【】（）()]*\p{Script=Han}[^【】（）()]*)[（(]([^【】（）()\p{Script=Han}]*\p{Script=Latin}[^【】（）()\p{Script=Han}]*)[）)]】/gu;
const englishSites = (text: string): string => text.replace(BILINGUAL_SITE, (_, _chinese: string, english: string) => `【${english.trim()}】`);

// A service point's brackets can hold its street address after its name: "【<name>，Address：<address>】".
const ADDRESS = /\s*[，,]\s*(?:address|地址)\s*[:：]/iu;
function withoutAddresses(text: string): string {
  return text.replace(/【([^【】]*)】/gu, (whole, site: string) => {
    const cut = ADDRESS.exec(site);
    if (!cut) return whole;
    const name = site.slice(0, cut.index);
    // A Chinese name keeps the English one in its brackets: 【<Chinese>（<English>，Address：…）】.
    return /[（(][^（(）)]*$/u.test(name) ? `【${name}）】` : `【${name}】`;
  });
}

// A courier's remark names them and gives their number: "… is being delivered by <name> (contact
// number: <number>. Please answer the call …)". The remark keeps neither.
const CONTACT = /\s*[（(]\s*(?:contact (?:number|phone)|联系电话|聯繫電話)\s*[:：].*$/isu;
const COURIER = /\s+by\s+[^()（）]{1,40}?(?=\s*[（(]\s*(?:contact (?:number|phone)|联系电话|聯繫電話)\s*[:：])/iu;
const withoutContact = (text: string): string => CONTACT.test(text) ? text.replace(COURIER, ' by the courier').replace(CONTACT, '') : text;

// A remark names the site of its scan in its first brackets: "The shipment has arrived at 【A】",
// "Shipment loaded at 【A】, prepare to send to 【B】". Some name it without them: one waiting in
// transit, "Shipment in transit at AU,TOWN, please wait in patience", and an operation centre's
// departure (302) and arrival (305), "The shipment has departed from A ,has been sent to B" and
// "The shipment has arrived atA". A remark about a courier or whoever signed may name a person
// there instead, and a country code given twice, "AU,AU", is no place. The place waited in leads
// with its country and ends with its town, "US,TX,TOWN"; it reads town first, "TOWN, TX, US".
const PERSON = /courier|deliver(?:y|er) ?(?:man|person|staff)|sign(?:ed|er)|recipient|收派员|快递员|派件员|配送员|签收|簽收|联系|聯繫/iu;
const IN_TRANSIT_AT = /\bin transit at\s+([^【】]*?\p{L}[^【】]*?)\s*[,，]\s*please wait/iu;
const CENTRE: ReadonlyMap<string, RegExp> = new Map([
  ['302', /\bdeparted from\s*([^【】,，]*?\p{L}[^【】,，]*?)\s*[,，]\s*has been sent to\b/iu],
  ['305', /\barrived at\s*([^【】,，]*?\p{L}[^【】,，]*?)\s*$/iu],
]);
const COUNTRY_TWICE = /^([A-Z]{2})\s*[,，]\s*\1$/iu;
const COUNTRY_FIRST = /^[A-Z]{2}\s*[,，]/u;
function scanSite(remark: string, code: string): string | undefined {
  const bracketed = /【([^【】]*\p{L}[^【】]*)】/u.exec(remark);
  const waited = bracketed ? null : IN_TRANSIT_AT.exec(remark);
  const site = (bracketed ?? waited ?? CENTRE.get(code)?.exec(remark))?.[1]?.trim();
  if (!site || site.length > 100 || COUNTRY_TWICE.test(site) || PERSON.test(remark)) return undefined;
  return waited && COUNTRY_FIRST.test(site) ? site.split(/[,，]/u).map((part) => part.trim()).filter(Boolean).reverse().join(', ') : site;
}

/** Parse the anonymous Taiwan routes endpoint, never a logged-in waybill detail. */
export function parse(payload: unknown, trackingNumber: string): CarrierResult {
  const number = normalizeSfExpressNumber(trackingNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER);
  if ((payload.code === 1 && typeof payload.detailMessage === 'string' && /captcha\s+verification failure/i.test(payload.detailMessage))
    || payload.code === 70000) throw new ChallengeError(PROVIDER);
  if (payload.code === 60000) throw new ChallengeError(PROVIDER, 'SF Express restricted the tracking query');
  if (payload.code === 500) throw new IndeterminateError(PROVIDER);
  if (payload.success !== true || payload.code !== 0 || !Array.isArray(payload.result)
    || payload.result.length > 20 || payload.result.some((entry) => !isRecord(entry))) throw new SchemaError(PROVIDER);
  // SF also answers an empty success envelope for waybills it has scanned. It answered, so the reason
  // tells it from an outage.
  if (!payload.result.length) throw new IndeterminateError(PROVIDER, 'SF Express returned no shipment', { reason: 'portal_not_found' });
  const results = payload.result.filter(isRecord).filter((entry) => entry.id === number);
  if (results.length !== 1) throw new SchemaError(PROVIDER, 'SF Express returned a different or ambiguous shipment');
  const shipment = results[0]!;
  if (!Array.isArray(shipment.routes) || !shipment.routes.length || shipment.routes.length > 500) {
    throw new SchemaError(PROVIDER, 'SF Express returned incomplete tracking history');
  }
  const scans: { local: string; time: string; status: ClassifiedStatus | undefined; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const raw of shipment.routes) {
    if (!isRecord(raw)) throw new SchemaError(PROVIDER, 'SF Express returned an invalid scan');
    const text = remarkText(raw.remark);
    // The portal removes these access links from history. They are not scans,
    // and the mere existence of a proof link does not establish delivery.
    if (/(?:AWB Info & POD|运单资料&签收图|運單資料&簽收圖)/.test(text)) continue;
    if (!text) throw new SchemaError(PROVIDER, 'SF Express returned an empty scan');
    const { local, time } = scanTime(raw.scanDateTime);
    const code = clean(raw.opCode, 64);
    const reason = clean(raw.stayWhyCode, 64);
    if (!/^[A-Z0-9_-]{1,64}$/.test(code)) throw new SchemaError(PROVIDER, 'SF Express returned an invalid operation code');
    const status = sfExpressEventStatus(code, reason, text);
    const description = status?.status === 'delivered' ? 'Delivered' : withoutContact(englishSites(withoutAddresses(text)));
    const site = status?.status === 'delivered' ? undefined : scanSite(description, code);
    const event: CarrierEvent = { time, provider_code: code, description,
      ...(site ? { location: site } : {}),
      ...(status ? { stage: status.stage } : {}),
    };
    const key = JSON.stringify([local, event.description, code, reason]);
    if (!seen.has(key)) { scans.push({ local, time, status, event }); seen.add(key); }
  }
  if (!scans.length) throw new SchemaError(PROVIDER, 'SF Express returned no historical scans');
  // The official frontend orders by these same wall clocks, which share one zone.
  if (listsNewestFirst(scans.map(({ event }) => event)) === false) scans.reverse();
  scans.sort((a, b) => b.local.localeCompare(a.local));
  const latest = scans[0]!;
  const state = clean(shipment.expressState, 64);
  const summaryStatus = sfExpressSummaryStatus(state, shipment.signed === true);
  // State 99 is broad transit: a mapped delivery-round scan is more precise.
  const status = state === '99' ? latest.status ?? summaryStatus : summaryStatus ?? latest.status;
  const summaryText = new Map([['2', 'Cancelled'], ['3', 'Forwarded'], ['4', 'Returned to sender'], ['5', 'Held'], ['6', 'Lost']]).get(state);
  // A delivered parcel's newest delivery scan dates its delivery.
  const delivery = status?.status === 'delivered' ? scans.find((scan) => scan.status?.status === 'delivered') : undefined;
  return { status: status?.status ?? 'unknown', ...(status ? { current_stage: status.stage } : {}),
    last_status_text: status?.status === 'delivered' ? 'Delivered' : summaryText ?? latest.event.description,
    last_update: latest.time, ...(delivery ? { delivered_at: delivery.time } : {}), expected_delivery: null,
    events: scans.slice(0, MAX_EVENTS).map((scan) => scan.event),
    ...(scans.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
