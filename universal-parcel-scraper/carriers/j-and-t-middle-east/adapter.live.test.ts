import { DateTime, FixedOffsetZone } from 'luxon';
import { describe, expect, it } from 'vitest';
import { firstOccurrence } from '../../core/time/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, J_AND_T_MIDDLE_EAST_API, SWITCHED_OFF_TICKET } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const KNOWN = process.env.J_AND_T_MIDDLE_EAST_TRACKING_NUMBER;
const UNKNOWN = process.env.J_AND_T_MIDDLE_EAST_UNKNOWN_NUMBER;

/** The instants of the scans the lookup returns when the request names `timezone`, read at its offset. */
async function scanInstants(number: string, timezone: string, offsetMinutes: number): Promise<number[]> {
  const response = await fetch(J_AND_T_MIDDLE_EAST_API, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: {
    'Content-Type': 'application/json;charset=UTF-8', langType: 'EN', timezone, countryId: '1',
  }, body: JSON.stringify({ waybillNo: [number], langType: 'EN', ticket: SWITCHED_OFF_TICKET, randstr: SWITCHED_OFF_TICKET }) });
  const body = await response.json() as { data: Array<{ details: Array<{ scanTime: string }> }> };
  return body.data[0]!.details.map((row) => firstOccurrence(DateTime.fromFormat(row.scanTime, 'yyyy-MM-dd HH:mm:ss',
    { zone: FixedOffsetZone.instance(offsetMinutes) })).toMillis());
}

describe('J&T Express Middle East live retrieval', () => {
  it.skipIf(!KNOWN)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: KNOWN!, carrier: 'j-and-t-middle-east' });
    expect(answer).toMatchObject({ carrier: 'j-and-t-middle-east', source: 'j-and-t-middle-east' });
    expect(answer.attempts[0]).toMatchObject({ source: 'j-and-t-middle-east', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has an instant at the offset the request names, and no wall clock of its own.
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:00$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.provider_code)).toBe(true);
  }, 75_000);

  // The tracker gives the scan times in the zone the request names: read at that offset, they are the same instants.
  it.skipIf(!KNOWN)('returns the same instants whatever zone the request names', async () => {
    const [saudi, emirati] = [await scanInstants(KNOWN!, 'GMT+0300', 180), await scanInstants(KNOWN!, 'GMT+0400', 240)];
    expect(saudi.length).toBeGreaterThan(0);
    expect(emirati).toEqual(saudi);
    const result = await direct().track({ number: KNOWN! });
    const instants = (times: number[]) => [...new Set(times)].sort((a, b) => a - b);
    expect(instants(result.events!.map((event) => Date.parse(String(event.time))))).toEqual(instants(saudi));
  }, 75_000);

  it.skipIf(!UNKNOWN)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});
