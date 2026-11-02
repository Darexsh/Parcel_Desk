import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { isoTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { classifyDelhiveryStatus } from './status.js';

function scanTime(value: unknown) {
  const raw = clean(value, 64);
  // A calendar day is not a midnight scan. Require the supplied civil clock
  // before applying the feed's India timezone to an offset-less timestamp.
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)
    ? isoTime(raw, 'Asia/Kolkata') : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (value: number) => String(value).padStart(2, '0');

// Freight milestones read "Sat, 29 Aug, 7:42 PM", India time without a year.
// The year is the one, no more than a year before the shipment's dated status,
// in which that day falls on that weekday; otherwise the text stays as written.
function milestoneTime(value: string, status: ParsedTime | null): ParsedTime | null {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{1,2}) ([A-Z][a-z]{2}), (\d{1,2}):(\d{2}) ([AP]M)$/.exec(value);
  const month = match ? MONTHS.indexOf(match[3]!) : -1;
  if (!match || !status || month < 0 || Number(match[4]) < 1 || Number(match[4]) > 12) return null;
  const day = Number(match[2]);
  const hour = Number(match[4]) % 12 + (match[6] === 'PM' ? 12 : 0);
  const statusYear = Number(status.iso.slice(0, 4));
  for (const year of [statusYear, statusYear - 1]) {
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCMonth() !== month || WEEKDAYS[date.getUTCDay()] !== match[1]) continue;
    const time = isoTime(`${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${match[5]}`, 'Asia/Kolkata');
    if (time && time.timestamp <= status.timestamp) return time;
  }
  return null;
}

export function normalizeDelhiveryNumber(raw: string): string {
  const number = raw.replace(/[\s.-]/g, '');
  if (!/^\d{13,14}$/.test(number)) throw new InvalidInputError('Delhivery', 'Delhivery requires a thirteen- or fourteen-digit waybill');
  return number;
}

export function parseDelhivery(payload: unknown, number: string): CarrierResult {
  const requested = normalizeDelhiveryNumber(number);
  if (!isRecord(payload) || payload.statusCode !== 200 || !Array.isArray(payload.data) || payload.data.length > 100) throw new SchemaError('Delhivery');
  if (!payload.data.length && payload.message === 'invalid AWB or very old package') throw new NotFoundError('Delhivery');
  const matches = payload.data.filter(isRecord).filter(item =>
    (typeof item.awb === 'string' ? item.awb.trim()
      : typeof item.awb === 'number' && Number.isSafeInteger(item.awb) ? String(item.awb) : '') === requested);
  if (matches.length !== 1) throw new SchemaError('Delhivery', 'Delhivery did not return one matching shipment');
  const item = matches[0]!;
  if (!isRecord(item.status) || !Array.isArray(item.trackingStates)) throw new SchemaError('Delhivery');
  const description = clean(item.status.status, 200);
  if (!description) throw new IndeterminateError('Delhivery', 'Delhivery returned no current status');
  const returning = item.status.statusType === 'RT' || item.currentFlow === 'Returned' || item.currentFlow === 'Reverse';
  // RETURNED names a flow, including parcels still travelling to the sender.
  // The separate shipment status establishes movement or completed delivery.
  const snapshotDescription = returning && description.toUpperCase() === 'RETURNED'
    ? clean(item.hqStatus, 200) : description;
  const current = classifyDelhiveryStatus(snapshotDescription);
  const mapped = returning && current?.stage === 'delivered'
    ? classifyDelhiveryStatus('RTO DELIVERED') : current;
  const updated = scanTime(item.status.statusDateTime);
  const currentTimeText = clean(item.status.statusDateTime, 64);
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  const reached = typeof item.currentTrackIndex === 'number' && Number.isSafeInteger(item.currentTrackIndex) ? item.currentTrackIndex : -1;
  let deliveredAt: ParsedTime | null = null;
  // Only completed scans and reached milestones become events. States past the
  // current index are the website's future progress rail and never claim movement.
  for (const [index, state] of item.trackingStates.slice(0, 100).entries()) {
    if (!isRecord(state)) throw new SchemaError('Delhivery', 'Delhivery returned an incomplete tracking state');
    if (state.scans !== undefined && state.scans !== null && !Array.isArray(state.scans)) {
      throw new SchemaError('Delhivery', 'Delhivery returned invalid scan history');
    }
    const scans: unknown[] = Array.isArray(state.scans) ? state.scans : [];
    // Freight replies date a reached milestone rather than its scans (a pickup
    // milestone can have none), so the milestone becomes an event of its own.
    const milestone = clean(state.label, 200);
    const milestoneText = clean(state.date, 64);
    if (index <= reached && milestone && milestoneText
      && !scans.some(scan => isRecord(scan) && clean(scan.scanDateTime, 64))) {
      const time = milestoneTime(milestoneText, updated);
      const status = classifyDelhiveryStatus(milestone);
      const classified = item.currentFlow === 'Reverse' && status?.stage === 'delivered' ? classifyDelhiveryStatus('RTO DELIVERED') : status;
      if (classified?.stage === 'delivered' && time && (!deliveredAt || time.timestamp > deliveredAt.timestamp)) deliveredAt = time;
      events.push({ description: milestone, ...(time ? { time: time.iso } : { provider_time_text: milestoneText }),
        ...(classified ? { stage: classified.stage } : {}), ...(item.currentFlow === 'Reverse' ? { provider_leg: 'return' } : {}) });
    }
    if (state.scans === undefined || state.scans === null) continue;
    for (const scan of scans.slice(0, 100)) {
      if (!isRecord(scan)) throw new SchemaError('Delhivery', 'Delhivery returned an incomplete scan row');
      if (events.length >= 500) continue;
      const label = clean(scan.scan, 200);
      if (!label) throw new SchemaError('Delhivery', 'Delhivery returned a scan with no description');
      const time = scanTime(scan.scanDateTime);
      const timeText = clean(scan.scanDateTime, 64);
      const location = clean(scan.cityLocation, 160);
      const returnScan = scan.scanType === 'RT' || item.currentFlow === 'Reverse';
      const key = `${time?.timestamp ?? timeText}\u0000${label}\u0000${location}\u0000${returnScan ? 'return' : ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const scanStatus = classifyDelhiveryStatus(label);
      const classified = returnScan && scanStatus?.stage === 'delivered'
        ? classifyDelhiveryStatus('RTO DELIVERED') : scanStatus;
      events.push({ description: label, ...(time ? { time: time.iso } : timeText ? { provider_time_text: timeText } : {}), ...(location ? { location } : {}),
        ...(classified ? { stage: classified.stage } : {}), ...(returnScan ? { provider_leg: 'return' } : {}) });
    }
  }
  // Repeated scan labels cannot bind a summary timestamp to a particular
  // historical location. Keep the dated status snapshot separate. A dated
  // delivered milestone already records the delivery the status repeats.
  const deliveryRecorded = mapped?.stage === 'delivered' && deliveredAt !== null;
  if (snapshotDescription && !deliveryRecorded && (!updated || !events.some(event => event.time && Date.parse(event.time) === updated.timestamp
    && event.description?.toUpperCase() === snapshotDescription.toUpperCase() && event.stage === mapped?.stage
    && (!returning || event.provider_leg === 'return')))) {
    events.unshift({ description: snapshotDescription, ...(updated ? { time: updated.iso } : currentTimeText ? { provider_time_text: currentTimeText } : {}),
      ...(mapped ? { stage: mapped.stage } : {}), ...(returning ? { provider_leg: 'return' } : {}), summary_snapshot: true });
  }
  const dated = events.filter(event => event.time);
  if (listsNewestFirst(dated) === false) dated.reverse();
  // The status snapshot stays ahead of a scan at its instant.
  dated.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!) || Number(Boolean(b.summary_snapshot)) - Number(Boolean(a.summary_snapshot)));
  const undated = events.filter(event => !event.time);
  // A freight status can date a later proof-of-delivery audit: its delivered milestone dates the delivery.
  const deliveryTime = deliveredAt ?? updated;
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage } : {}),
    last_status_text: description, last_update: updated?.iso ?? null, expected_delivery: null,
    ...(mapped?.status === 'delivered' && deliveryTime ? { delivered_at: deliveryTime.iso } : {}),
    timezone: 'Asia/Kolkata', events: [...dated, ...undated].slice(0, 100) };
}
