import { describe, expect, it } from 'vitest';
import { event, localEvent, result } from './result.js';

describe('shared provider result', () => {
  it('drops an entry in wording no rule reads when it is dated at the lookup', () => {
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago).toISOString();
    const scan = event(at(86_400_000), 'Arrived at sorting center')!;
    const notice = event(at(1_000), 'Example notice nobody has worded before')!;
    expect(notice.stage_source).toBe('none');
    expect(result([notice, scan], 'ParcelsApp').events?.map(({ description }) => description)).toEqual(['Arrived at sorting center']);
    // A provider's clock can run ahead of ours.
    expect(result([event(new Date(now + 60_000).toISOString(), notice.description)!, scan], 'ParcelsApp').events).toHaveLength(1);
    // Read wording that new is a scan, and unread wording an hour old is a scan in words no rule knows yet.
    expect(result([event(at(1_000), 'Delivered')!, scan], 'ParcelsApp').events).toHaveLength(2);
    expect(result([event(at(3_600_000), notice.description)!, scan], 'ParcelsApp').events).toHaveLength(2);
    // A notice alone says nothing about the parcel.
    expect(() => result([notice], 'ParcelsApp')).toThrow('No usable tracking events');
  });

  it('sets aside a timeline written to a schedule, rows a fixed time apart to the second', () => {
    const day = Date.parse('2026-03-02T10:03:26Z');
    const clock = (ms: number) => new Date(ms).toISOString();
    const scan = event('2026-03-01T08:12:47Z', 'Shenzhen Processing Center has received it')!;
    // 47 hours 21 minutes apart, the seconds stepping by one now and then.
    const steps = [0, 170_460, 340_921, 511_382, 681_842].map((offset) => event(clock(day + offset * 1_000), 'In transit')!);
    const relayed = result([scan, ...steps], '17TRACK');
    expect(relayed.events!.map(({ time }) => time)).toEqual(['2026-03-01T08:12:47.000Z']);
    expect(relayed).toMatchObject({ current_stage: 'accepted', last_status_text: 'Shenzhen Processing Center has received it' });
    expect(() => result(steps, '17TRACK')).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'written_ahead' }));
    // Three such rows, rows whose spacing drifts, and rows dated on whole minutes stay.
    expect(result([scan, ...steps.slice(0, 3)], '17TRACK').events).toHaveLength(4);
    const drifting = [0, 170_460, 340_925, 511_390].map((offset) => event(clock(day + offset * 1_000), 'In transit')!);
    expect(result([scan, ...drifting], '17TRACK').events).toHaveLength(5);
    const daily = [1, 2, 3, 4, 5].map((date) => event(`2026-03-0${date}T09:00:00Z`, 'In transit')!);
    expect(result(daily, '17TRACK').events).toHaveLength(5);
  });

  it('drops a generic "On the way" beside a specific scan at its instant and place, as FedEx writes it', () => {
    const at = (time: string, description: string, location: string) => ({ ...event(time, description)!, location });
    const relayed = result([
      at('2026-10-28T19:13:00Z', 'On the way', 'EXAMPLE CITY FR'),
      at('2026-10-28T19:13:00Z', 'Departed FedEx hub', 'EXAMPLE CITY FR'),
      at('2026-10-28T19:13:00Z', 'On the way', 'OTHER CITY FR'),
      at('2026-10-28T08:00:00Z', 'On the way', 'EXAMPLE CITY FR'),
    ], 'ParcelsApp');
    expect(relayed.events?.map(({ description, location }) => [description, location])).toEqual([
      ['On the way', 'OTHER CITY FR'],
      ['Departed FedEx hub', 'EXAMPLE CITY FR'],
      ['On the way', 'EXAMPLE CITY FR'],
    ]);
  });

  it("keeps no time for the seller's step or GLS's progress sentence when dated after the lookup", () => {
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const ahead = result([event(at(22 * 3_600_000), 'Pending shipping by the seller')!], 'ParcelsApp');
    expect(ahead).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null });
    expect(ahead.events).toHaveLength(1);
    expect(ahead.events?.[0]).not.toHaveProperty('time');
    // Dated before the lookup, it is the moment of the step.
    expect(result([event(at(-3_600_000), 'Pending shipping by the seller')!], 'ParcelsApp').events?.[0]?.time).toBe(at(-3_600_000));
    // So does GLS's progress bar sentence, dated by GLS's delivery estimate.
    const summary = 'The parcel is on its way to the final parcel center. For more information, please see the detailed shipment tracking below.';
    expect(result([event(at(60 * 3_600_000), summary, 'in_transit')!], 'ParcelsApp').events?.[0]).not.toHaveProperty('time');
    expect(result([event(at(-3_600_000), summary, 'in_transit')!], 'ParcelsApp').events?.[0]?.time).toBe(at(-3_600_000));
    // Another scan dated ahead keeps its time, for the parcel app to flag.
    expect(result([event(at(22 * 3_600_000), 'Arrived at sorting center')!], 'ParcelsApp').events?.[0]?.time).toBe(at(22 * 3_600_000));
  });

  it("reads GLS's ParcelShop scan by the carrier scans around it", () => {
    const shop = 'The parcel has reached the ParcelShop';
    const stageOf = (events: (ReturnType<typeof event>)[]) => result(events.map((entry) => entry!), 'Postal Ninja').events
      ?.find(({ description }) => description === shop)?.stage;
    // The sender's drop-off, before GLS has the parcel.
    expect(stageOf([event('2026-03-02T16:01:10Z', shop), event('2026-03-04T16:43:41Z', 'The parcel was handed over to GLS'),
      event('2026-03-05T11:30:00Z', 'Delivered')])).toBe('accepted');
    // The parcel waiting for collection, after GLS carried it.
    expect(stageOf([event('2026-03-02T16:43:41Z', 'The parcel was handed over to GLS'),
      event('2026-03-03T09:00:00Z', 'The parcel has left the parcel center'), event('2026-03-04T10:00:00Z', shop)])).toBe('ready_for_pickup');
    // Alone, or after the label alone, the wording does not say which.
    expect(stageOf([event('2026-03-02T16:01:10Z', shop)])).toBe('pending');
    expect(stageOf([event('2026-03-01T08:00:00Z', 'Shipment information received', 'registered'), event('2026-03-02T16:01:10Z', shop)])).toBe('pending');
  });

  it('puts a step dated by its day alone above the newest scan of its day at an earlier stage', () => {
    const scan = (clock: string, description: string, stage: string) => ({
      ...(clock.length === 10 ? { local_time: clock } : { time: clock }), description, stage, stage_source: 'carrier_map',
    });
    const order = (events: ReturnType<typeof scan>[], preserveOrder = false) => result(events, 'ParcelsApp', preserveOrder)
      .events?.map(({ description }) => description);
    const history = [
      scan('2026-01-06T09:00:00-05:00', 'Departed sorting center', 'in_transit'),
      scan('2026-01-05', 'Picked up', 'accepted'),
      scan('2026-01-05T20:41:00-05:00', 'Arrived at sorting center', 'in_transit'),
      scan('2026-01-05T09:17:00-05:00', 'Shipment information sent', 'registered'),
      scan('2026-01-04T10:00:00-05:00', 'Order created', 'pending'),
    ];
    expect(order(history)).toEqual(['Departed sorting center', 'Arrived at sorting center', 'Picked up', 'Shipment information sent', 'Order created']);
    // With no scan of its day at an earlier stage, or no stage, it stays below the day's timed scans.
    expect(order([history[1]!, history[2]!, { ...history[3]!, stage: 'accepted' }])).toEqual([
      'Arrived at sorting center', 'Shipment information sent', 'Picked up',
    ]);
    expect(order([{ ...history[1]!, stage: 'exception' }, history[3]!])).toEqual(['Shipment information sent', 'Picked up']);
    // A provider whose order stands keeps it.
    expect(order([history[3]!, history[1]!], true)).toEqual(['Shipment information sent', 'Picked up']);
  });

  it('keeps scans of one instant in the order the provider listed them, oldest or newest first', () => {
    const scan = (time: string, description: string) => ({ time, description, stage: 'in_transit', stage_source: 'carrier_map' });
    const oldestFirst = [
      scan('2026-01-05T09:00:00Z', 'Accepted at sorting center'), scan('2026-01-05T20:41:00Z', 'Arrived at sorting center'),
      scan('2026-01-05T20:41:00Z', 'Departed sorting center'), scan('2026-01-06T09:00:00Z', 'Arrived at delivery depot'),
    ];
    const newest = ['Arrived at delivery depot', 'Departed sorting center', 'Arrived at sorting center', 'Accepted at sorting center'];
    expect(result(oldestFirst, 'ParcelsApp').events?.map(({ description }) => description)).toEqual(newest);
    expect(result([...oldestFirst].reverse(), 'ParcelsApp').events?.map(({ description }) => description)).toEqual(newest);
  });

  it("reads a copy of SunYou's departure without the last-mile number, as SunYou's own result does", () => {
    expect(event('2026-01-07T12:45:00+08:00', 'Departed Sunyou Facility, Carrier Tracking Number:  ZZ000000005GB'))
      .toMatchObject({ description: 'Departed Sunyou Facility' });
  });

  it("reads Chronopost's notice to the recipient without the message type and medium appended to it", () => {
    const notice = 'Destinataire informé par SMS ou mail';
    for (const relayed of [`${notice}. Type du message : Retard Média utilisé : E-mail`, `${notice} Type du message : Echec de livraison`]) {
      expect(event('2026-01-07T12:45:00+01:00', relayed)).toMatchObject({ description: notice, stage: 'pending', stage_source: 'none' });
    }
    expect(event('2026-01-07T12:45:00+01:00', `${notice}. Rendez-vous`)?.description).toBe(`${notice}. Rendez-vous`);
  });

  it("leaves out DHL's detail line saying no further details are required, but not the scan beside it", () => {
    expect(event('2026-01-07T12:45:00Z', 'Keine weiteren Details erforderlich')).toBeNull();
    expect(localEvent('2026-01-07T12:45:00', 'Keine weiteren Details erforderlich.')).toBeNull();
    expect(event('2026-01-07T12:44:00Z', 'Entladung')).toMatchObject({ description: 'Entladung', stage: 'in_transit' });
    expect(event('2026-01-07T12:45:00Z', 'Keine weiteren Details erforderlich, Entladung')).not.toBeNull();
  });

  it("leaves out 17FEIA's estimated departure, written before the flight, so it cannot undo a customs step", () => {
    expect(event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18')).toBeNull();
    expect(event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18, OTHER', 'InTransit')).toBeNull();
    expect(localEvent('2026-01-07T09:16:18', 'Estimated departure date: 2026-01-08 17:16:18')).toBeNull();
    const customs = event('2026-01-07T08:20:00Z', 'Export declaration in progress.')!;
    expect(result([event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18'), customs]
      .filter((scan) => scan !== null), 'ParcelsApp')).toMatchObject({ current_stage: 'customs' });
  });

  it("leaves out a carrier's schedule, dated when it is due: a vessel's estimated departure and arrival, the cut-off, a flight's ETD or ETA", () => {
    for (const label of ['Estimated Vessel Departure', 'Estimated Vessel Departure (Last Updated)', 'Estimated Vessel Arrival',
      'Estimated Vessel Arrival (Last Updated)', 'CFS/CY Cut-Off Date', 'Flight ETD Sep 23.', 'Flight ETA Sep 25.']) {
      expect(event('2026-12-10T11:00:00Z', label, 'InTransit')).toBeNull();
    }
    expect(event('2026-10-05T01:27:00Z', 'Actual Vessel Departure', 'InTransit')).toMatchObject({ stage: 'in_transit' });
    expect(event('2026-10-06T08:03:00Z', 'Customer Booking Received', 'InTransit')).not.toBeNull();
  });

  it('leaves out a bracketed time with no words, which names no scan', () => {
    expect(event('2026-01-07T10:52:13+08:00', '( 10：23)', 'InTransit')).toBeNull();
    expect(localEvent('2026-01-07T10:52:13', '(10:23)')).toBeNull();
    expect(localEvent('2026-01-07T17:04:29', '(01.08)')).toBeNull();
    expect(event('2026-01-07T10:52:13+08:00', 'Departed (10:23)', 'InTransit')).toMatchObject({ stage: 'in_transit' });
  });

  it('leaves out a language label with no words after it', () => {
    expect(event('2026-01-07T16:17:00+08:00', '(中文:)', 'InTransit')).toBeNull();
    expect(event('2026-01-07T16:17:00+08:00', '（English：）', 'InTransit')).toBeNull();
    expect(event('2026-01-07T16:17:00+08:00', '(中文:已出库)', 'InTransit')).not.toBeNull();
  });

  it("reads Sameday's Bulgarian steps before it has the parcel, as ParcelsApp relays them", () => {
    expect(event('2026-01-07T12:45:00+02:00', 'Скоро ще вземем пратката Ви от подателя.'))
      .toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
    expect(event('2026-01-21T12:45:00+02:00', 'Подателят не предаде пратката.'))
      .toMatchObject({ stage: 'exception', stage_source: 'wording:provider' });
  });

  it("reads Russian Post's hand-over to the addressee or the sender, as ParcelsApp relays it and Postal Ninja translates it", () => {
    for (const wording of ['Вручение адресату', 'Вручение адресату почтальоном', 'Вручено 22 октября', 'Handed over. Delivery to the addressee by the postman']) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage: 'delivered', stage_source: 'wording:provider' });
    }
    for (const wording of ['Вручение отправителю', 'Handed over. Delivery to the sender']) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage: 'returned', stage_source: 'wording:provider' });
    }
    // The label the sender made, before the post office has the parcel.
    expect(event('2026-01-07T12:45:00+03:00', 'Tracking number assigned')).toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
  });

  it("reads Russian Post's steps on mail from abroad, as 17TRACK and ParcelsApp relay them", () => {
    const stages: ReadonlyArray<readonly [string, string]> = [
      ['Таможенное декларирование,Данные от торговой площадки получены', 'registered'],
      ['Prepared for shipping', 'registered'],
      ['Прием', 'accepted'],
      ['Приём', 'accepted'],
      ['Acceptance', 'accepted'],
      ['Обработка,Прибыло в место международного обмена', 'in_transit'],
      ['Покинуло место международного обмена', 'in_transit'],
      ['Shipped from China', 'in_transit'],
      ['Прием на таможню', 'customs'],
      ['Таможенное оформление', 'customs'],
    ];
    for (const [wording, stage] of stages) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage, stage_source: 'wording:provider' });
    }
    // A clearance with its outcome, and the delivery office, are other steps.
    for (const wording of ['Таможенное оформление, Выпущено таможней', 'Обработка, Прибыло в место вручения']) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage_source: 'none' });
    }
  });

  it("reads Yanwen's scan after its pickup, as ParcelsApp relays it", () => {
    expect(event('2026-01-07T12:45:00+08:00', 'Processing information input'))
      .toMatchObject({ stage: 'accepted', stage_source: 'wording:provider' });
  });

  it("reads Interpost's import clearance by its caption, without the status code ParcelsApp heads it with", () => {
    expect(event('2026-01-07T12:45:00+01:00', 'B2C Clearance 4. Customs Import cleared'))
      .toMatchObject({ description: 'Customs Import cleared', stage: 'in_transit' });
    // The code alone has no caption to show instead.
    expect(event('2026-01-07T12:45:00+01:00', 'B2C Clearance 4.')?.description).toBe('B2C Clearance 4.');
    expect(event('2026-01-07T12:45:00+01:00', 'Customs Clearance. Customs Import submitted')?.description)
      .toBe('Customs Clearance. Customs Import submitted');
  });
});
