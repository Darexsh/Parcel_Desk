import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { carrierScan } from '../../providers/shared/scans.js';
import statuses from './statuses.json' with { type: 'json' };
import { emileScan } from './status.js';

const number = 'EM000000000001CA';

/** A ParcelsApp reply whose states, newest first, are filed under Emile's name unless they name another carrier. */
async function track(states: ReadonlyArray<readonly [status: string, carrier?: number]>) {
  const reply = {
    carriers: ['Yun Express', 'eMile'], services: [], status: 'transit', originCode: 'CN', destinationCode: 'CA',
    states: states.map(([status, carrier = 1], index) => ({
      location: 'Example Hub', date: `2026-01-0${9 - index}T12:00:00Z`, carrier, status })),
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url) === 'https://www.emileps.com/emile/track'
    ? new Response(`<root><status>0</status><tracks error_message="Order [${number}] not found trackingevent."/></root>`)
    : new Response(JSON.stringify(reply), { headers: { 'Content-Type': 'application/json' } }));
  return (await createTracker({ providers: ['ParcelsApp'], fetcher }).track({ number, carrier: 'emile' })).result;
}

describe('Emile status vocabulary', () => {
  it('stages every recorded status text in any case and keeps the wording relayed', () => {
    for (const entry of statuses.entries) {
      const stage = entry.stage ?? 'pending';
      expect(carrierScan('emile', entry.wording), entry.wording).toEqual({ stage, wording: entry.wording });
      const relayed = entry.wording.charAt(0) + entry.wording.slice(1).toLowerCase();
      expect(emileScan(relayed), relayed).toEqual({ stage, wording: relayed });
    }
    expect(emileScan('ORDER SORTED AT THE HUB')).toBeUndefined();
  });

  it('keeps a parcel handed over or picked up after customs in transit', async () => {
    const result = await track([['PICKED UP'], ['HANDED OVER'], ['CUSTOMS RELEASED'], ['CBSA HAS PUT THE FOLLOWING SHIPMENTS ON HOLD']]);
    expect(result).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(result.events.map((event) => [event.description, event.stage, event.stage_source])).toEqual([
      ['PICKED UP', 'in_transit', 'carrier_map'],
      ['HANDED OVER', 'in_transit', 'carrier_map'],
      ['CUSTOMS RELEASED', 'in_transit', 'carrier_map'],
      ['CBSA HAS PUT THE FOLLOWING SHIPMENTS ON HOLD', 'customs', 'carrier_map'],
    ]);
  });

  it('reads a new delivery round, a destroyed parcel and a notice to the sender as Emile files them', async () => {
    expect(await track([['RE-DELIVERY ATTEMPT'], ['OUT FOR DELIVERY']])).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(await track([['ORDER DESTROYED'], ['ARRIVE TRANSITHUB']])).toMatchObject({ current_stage: 'exception' });
    expect(await track([['EXCEPTION NOTIFIED TO SENDER'], ['ARRIVE TRANSITHUB']])).toMatchObject({ current_stage: 'exception' });
    expect(await track([['Task assigned'], ['Waybill generated']])).toMatchObject({
      current_stage: 'in_transit', events: [{ description: 'Task assigned' }, { description: 'Waybill generated', stage: 'registered' }],
    });
    const delivered = await track([['DELIVERED'], ['OUT FOR DELIVERY']]);
    expect(delivered.events[0]).toMatchObject({ description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads a return as finished, without rewording the scans after it', async () => {
    const result = await track([['DELIVERED'], ['OUT FOR DELIVERY'], ['RETURNED TO SENDER'], ['DELIVERY EXCEPTION']]);
    expect(result).toMatchObject({ current_stage: 'delivered' });
    expect(result.events.map((event) => [event.description, event.stage, event.provider_leg])).toEqual([
      ['Delivered', 'delivered', undefined],
      ['OUT FOR DELIVERY', 'out_for_delivery', undefined],
      ['RETURNED TO SENDER', 'returned', undefined],
      ['DELIVERY EXCEPTION', 'exception', undefined],
    ]);
  });

  it('lets a fee, a reminder or a wait for pickup leave the parcel at the stage it had', async () => {
    for (const status of ['WAITING FOR PICKUP', 'EMAIL REMINDER SENT / FAILED', 'WEIGHT_MISMATCH_FEE']) {
      const result = await track([[status], ['OUT FOR DELIVERY']]);
      expect(result, status).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: status });
      expect(result.events[0], status).toMatchObject({ description: status, stage: 'pending', stage_source: 'carrier_map' });
    }
  });

  it('leaves the scans filed under a consolidator\'s name to the shared wording rules', async () => {
    const result = await track([['HANDED OVER', 0], ['ARRIVE TRANSITHUB', 0]]);
    expect(result.events.map((event) => event.stage_source)).not.toContain('carrier_map');
  });
});
