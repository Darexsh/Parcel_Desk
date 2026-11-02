import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { chinaPostDescription, checkChinaPostGate, normalizeChinaPostNumber, parseChinaPostTraces } from './parser.js';
import { chinaPostCountry, statusMap } from './status.js';

const NUMBER = 'LZ123456785CN';
type Mail = Record<string, unknown>;
interface Payload { code: string; msg: string; info: { mail: Mail } }
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Payload;
const scans = (mail: Mail) => mail.mailInfos as Record<string, unknown>[];
const scan = (mail: Mail, index: number) => scans(mail)[index]!;
// A wall clock with its instant on China's clock.
const china = (local: string) => ({ local_time: local, time: `${local}+08:00`, time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier' });
const edit = (name: string, change: (mail: Mail) => void) => {
  const payload = fixture(name);
  change(payload.info.mail);
  return payload;
};

describe('China Post number scope', () => {
  it('accepts S10 numbers issued in China and ZS, ZC or ZA numbers only', () => {
    expect(normalizeChinaPostNumber(' lz 123 456 785 cn ')).toBe(NUMBER);
    expect(normalizeChinaPostNumber('zs 0000 0000 001')).toBe('ZS00000000001');
    expect(normalizeChinaPostNumber('zc 0000 0000 001')).toBe('ZC00000000001');
    expect(normalizeChinaPostNumber('za 0000 0000 001')).toBe('ZA00000000001');
    for (const number of ['LZ123456780CN', 'LZ123456785FR', '1100000000000', '9800000000000', 'LZ12345678CN',
      'ZS0000000001', 'ZS000000000001', 'ZC0000000001', 'ZC000000000001', 'ZA0000000001', 'ZA000000000001', 'ZT00000000001', 'ZB00000000001']) {
      expect(() => normalizeChinaPostNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('China Post trace projection', () => {
  it("returns the newest scans first, the destination post's on its wall clock, dates the acceptance and flags the truncated history", () => {
    const result = normalizeCarrierResult(parseChinaPostTraces(fixture('delivered'), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-09-01T15:25:00',
      destination_country: 'US', history_truncated: true });
    expect(result.events).toEqual([
      { local_time: '2026-09-01T15:25:00', description: 'Delivered', location: 'United States', provider_code: '463', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-09-01T10:10:00', description: 'Out for delivery', location: 'United States', provider_code: '462', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-09-01T08:10:00', description: 'Arrived at the delivery office', location: 'United States', provider_code: '461', stage: 'in_transit', stage_source: 'carrier_map' },
      { ...china('2026-08-14T16:13:38'), description: 'Accepted', location: '示例市揽投部', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result.timezone).toBeUndefined();
    expect(result.delivered_at).toBeUndefined();
  });

  it('keeps export customs scans and leaves a complete history unflagged', () => {
    const result = parseChinaPostTraces(fixture('customs'), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'customs', destination_country: 'NZ', last_status_text: 'Held by export customs for inspection' });
    expect(result.history_truncated).toBeUndefined();
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([['EXB', 'customs'], ['EXA', 'customs'], ['954', 'in_transit']]);
    expect(result.events?.[2]).toMatchObject({ description: 'Arrival', location: '示例市国际互换局' });
  });

  it('drops courier contacts and signers from scan text', () => {
    const result = parseChinaPostTraces(fixture('returned'), NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Returned', destination_country: 'IN' });
    expect(result.events?.map((event) => event.description)).toEqual(['Returned', 'Out for delivery', 'Arrival', 'Accepted']);
    expect(result.events?.map((event) => event.stage)).toEqual(['returned', 'out_for_delivery', 'in_transit', 'accepted']);
  });

  it('never projects personal, courier, address or map fields', () => {
    for (const name of ['delivered', 'returned', 'customs']) {
      const result = parseChinaPostTraces(fixture(name), NUMBER);
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/PRIVATE|10000000000|11183|0\.00000|example\.invalid|电话|快递员|签收【/);
      expect(Object.keys(result).sort()).toEqual(expect.arrayContaining(['events', 'last_status_text', 'status']));
      for (const event of result.events ?? []) {
        expect(Object.keys(event).every((key) => ['local_time', 'time', 'time_zone', 'time_zone_basis', 'description', 'location', 'provider_code', 'stage', 'stage_source'].includes(key))).toBe(true);
      }
    }
  });

  it('binds the record to the requested number', () => {
    expect(() => parseChinaPostTraces(edit('delivered', (mail) => { mail.mailNo = 'LZ000000005CN'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema', message: expect.stringContaining('different shipment') }));
    expect(() => parseChinaPostTraces(edit('delivered', (mail) => { delete mail.mailNo; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseChinaPostTraces(edit('delivered', (mail) => { mail.mailNo = NUMBER.toLowerCase(); }), NUMBER).events).toHaveLength(4);
  });

  it('keeps an empty record inconclusive and rejects malformed ones', () => {
    expect(() => parseChinaPostTraces(edit('delivered', (mail) => { mail.mailInfos = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    // The app shows "no logistics information" for these shapes.
    for (const info of [null, { mail: null }, { mail: '' }, { mail: {} }]) {
      expect(() => parseChinaPostTraces({ code: '000000', msg: 'SUCCESS', info }, NUMBER))
        .toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate', message: expect.stringContaining('no tracking information') }));
    }
    for (const info of [{}, 'mail', 3, { mail: 'record' }, { mail: 3 }, { mail: [] }, { mail: { mailNo: '' } }]) {
      expect(() => parseChinaPostTraces({ code: '000000', msg: 'SUCCESS', info }, NUMBER), JSON.stringify(info)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseChinaPostTraces({ code: '000000', msg: 'SUCCESS' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const change of [
      (mail: Mail) => { mail.mailInfos = null; },
      (mail: Mail) => { mail.mailInfos = Array.from({ length: 501 }, () => scan(mail, 0)); },
      (mail: Mail) => { (mail.mailInfos as unknown[])[2] = 'scan'; },
      (mail: Mail) => { scan(mail, 2).time = '2026-02-30 09:00:00'; },
      (mail: Mail) => { scan(mail, 2).time = '2026-09-01T15:25:00+08:00'; },
      (mail: Mail) => { Object.assign(scan(mail, 2), { operation: '', stateDesc: '' }); },
    ]) {
      expect(() => parseChinaPostTraces(edit('delivered', change), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const missing = fixture('delivered');
    Reflect.deleteProperty(missing.info, 'mail');
    expect(() => parseChinaPostTraces(missing, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseChinaPostTraces({ msg: 'SUCCESS' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('removes duplicate scans and flags a history it had to cut', () => {
    const duplicate = parseChinaPostTraces(edit('delivered', (mail) => { scans(mail).push({ ...scan(mail, 2) }); }), NUMBER);
    expect(duplicate.events?.filter((event) => event.provider_code)).toHaveLength(3);
    const long = parseChinaPostTraces(edit('delivered', (mail) => {
      mail.mailInfos = Array.from({ length: 120 }, (_, index) => ({ ...scan(mail, 0), time: `2026-08-${String(1 + (index % 28)).padStart(2, '0')} 08:${String(index % 60).padStart(2, '0')}:00` }));
      mail.mailInfoCount = 120;
    }), NUMBER);
    expect(long.events).toHaveLength(100);
    expect(long.history_truncated).toBe(true);
    const accepted = parseChinaPostTraces(edit('delivered', (mail) => {
      mail.mailInfos = Array.from({ length: 120 }, (_, index) => ({ ...scan(mail, 0), time: `2026-08-${String(15 + (index % 14)).padStart(2, '0')} 08:${String(index % 60).padStart(2, '0')}:00` }));
      mail.mailInfoCount = 130;
    }), NUMBER);
    expect(accepted.events).toHaveLength(100);
    expect(accepted.events?.at(-1)).toMatchObject({ description: 'Accepted', stage: 'accepted' });
    expect(accepted.history_truncated).toBe(true);
  });

  it('flags a full guest window whose count is missing or unreadable', () => {
    const counted = (count: unknown, keep = 3) => parseChinaPostTraces(edit('delivered', (mail) => {
      if (count === undefined) delete mail.mailInfoCount;
      else mail.mailInfoCount = count;
      mail.mailInfos = scans(mail).slice(3 - keep);
    }), NUMBER);
    expect(counted('40')).toMatchObject({ history_truncated: true });
    expect(counted('40').events).toHaveLength(4);
    for (const count of [undefined, null, '', 'many', -1, 4.5, {}]) {
      const result = counted(count);
      expect(result.history_truncated, JSON.stringify(count)).toBe(true);
      expect(result.events?.map((event) => event.provider_code)).toEqual(['463', '462', '461']);
    }
    expect(counted(undefined, 2).history_truncated).toBeUndefined();
    expect(counted('2', 2).history_truncated).toBeUndefined();
    expect(counted(3).history_truncated).toBeUndefined();
  });

  it('reads only the time and office of a collector that precedes the returned scans', () => {
    const accepted = (change: (collector: Record<string, unknown>) => void) => parseChinaPostTraces(edit('delivered', (mail) => {
      change(mail.collector as Record<string, unknown>);
    }), NUMBER).events?.slice(3);
    expect(accepted(() => undefined)).toEqual([
      { ...china('2026-08-14T16:13:38'), description: 'Accepted', location: '示例市揽投部', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(accepted((collector) => { collector.orgName = '示例市揽投部电话10000000000'; })).toEqual([
      { ...china('2026-08-14T16:13:38'), description: 'Accepted', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    for (const change of [
      (collector: Record<string, unknown>) => { collector.opTime = '2026-09-01 08:10:00'; },
      (collector: Record<string, unknown>) => { collector.opTime = '2026-09-02 08:10:00'; },
      (collector: Record<string, unknown>) => { collector.opTime = ''; },
      (collector: Record<string, unknown>) => { collector.opTime = '2026-02-30 09:00:00'; },
      (collector: Record<string, unknown>) => { delete collector.opTime; },
    ]) {
      expect(accepted(change)).toEqual([]);
    }
    const none = parseChinaPostTraces(edit('delivered', (mail) => { mail.collector = null; }), NUMBER);
    expect(none.events).toHaveLength(3);
    expect(none.history_truncated).toBe(true);
    const complete = parseChinaPostTraces(edit('delivered', (mail) => { mail.mailInfoCount = 3; }), NUMBER);
    expect(complete.events).toHaveLength(3);
    expect(JSON.stringify(parseChinaPostTraces(fixture('delivered'), NUMBER))).not.toMatch(/PRIVATE|99999999|00000001|10000000000/);
  });

  it('keeps domestic flight legs', () => {
    const result = parseChinaPostTraces(edit('customs', (mail) => {
      Object.assign(scan(mail, 1), { operationCode: '911', operation: '邮件已乘机由【示例市】飞往【示例二市】', stateDesc: '已起飞', orgName: '示例航站包件车间' });
      Object.assign(scan(mail, 2), { operationCode: '912', operation: '邮件到达【示例二市】，准备发往【示例航空中心】', stateDesc: '已落地', orgName: '示例航空中心' });
      mail.stateDesc = '已落地';
    }), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrival' });
    expect(result.events?.slice(0, 2)).toEqual([
      { ...china('2026-09-03T10:06:42'), description: 'Arrival', location: '示例航空中心', provider_code: '912', stage: 'in_transit', stage_source: 'carrier_map' },
      { ...china('2026-09-03T09:38:32'), description: 'Left on a flight', location: '示例航站包件车间', provider_code: '911', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
  });

  it('falls back to the state label for unmapped scan codes and keeps unknown labels unclassified', () => {
    const relabelled = parseChinaPostTraces(edit('delivered', (mail) => {
      scan(mail, 2).operationCode = '999';
    }), NUMBER);
    expect(relabelled).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(relabelled.events?.[0]).toMatchObject({ provider_code: '999', stage: 'delivered' });
    const unknown = parseChinaPostTraces(edit('delivered', (mail) => {
      Object.assign(scan(mail, 2), { operationCode: '999', operation: '邮件状态变更', stateDesc: '未知状态' });
      mail.stateDesc = '未知状态';
    }), NUMBER);
    expect(unknown.status).toBe('unknown');
    expect(unknown.current_stage).toBeUndefined();
    expect(unknown.events?.[0]).not.toHaveProperty('stage');
    const fromMail = parseChinaPostTraces(edit('delivered', (mail) => {
      Object.assign(scan(mail, 2), { operationCode: '999', stateDesc: '' });
    }), NUMBER);
    expect(fromMail).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    for (const [state, status, stage] of [['正在安排派送', 'out_for_delivery', 'out_for_delivery'], ['待退回', 'exception', 'returned']]) {
      const labelled = parseChinaPostTraces(edit('delivered', (mail) => {
        Object.assign(scan(mail, 2), { operationCode: '999', operation: '邮件状态变更', stateDesc: state });
      }), NUMBER);
      expect(labelled, state).toMatchObject({ status, current_stage: stage, current_stage_source: 'carrier_map' });
    }
    const numeric = parseChinaPostTraces(edit('delivered', (mail) => { scan(mail, 2).operationCode = 463; }), NUMBER);
    expect(numeric.events?.[0]).toMatchObject({ provider_code: '463', stage: 'delivered' });
  });

  it("gives each fixture scan the stage its status map answers for the scan's code and wording", () => {
    for (const name of ['delivered', 'returned', 'customs']) {
      for (const event of parseChinaPostTraces(fixture(name), NUMBER).events ?? []) {
        expect(statusMap.stage(event.provider_code ?? null, normalizeStatusWording(event.description ?? '')), `${name}: ${event.description}`)
          .toBe(event.stage);
      }
    }
  });

  it('places a foreign scan without an office name in the destination country its code names, in English', () => {
    const located = (orgCode: unknown, receiverCountryName = '美国') => parseChinaPostTraces(edit('delivered', (mail) => {
      Object.assign(scan(mail, 0), { operationCode: '489', operation: '离开境外经转局', orgName: '', orgCode });
      mail.receiverCountryName = receiverCountryName;
    }), NUMBER).events?.[2];
    expect(located('US')).toMatchObject({ description: 'Departed from a transit office abroad', location: 'United States', provider_code: '489' });
    expect(located('us')).toMatchObject({ location: 'United States' });
    // A UPU office of exchange code starts with its country's code.
    expect(located('USJFKA')).toMatchObject({ location: 'United States' });
    expect(located('COBOGC', '哥伦比亚')).toMatchObject({ location: 'Colombia' });
    // A transit country, an airline, a Chinese office or an unknown destination stays unplaced.
    for (const [orgCode, country] of [['BR', '美国'], ['CF', '美国'], ['HKG', '美国'], ['00000001', '美国'], ['', '美国'], [null, '美国'],
      ['US', '示例国'], ['US', ''], ['COBOGC', '美国'], ['USJFK', '美国'], ['USJFKAB', '美国'], ['US0001', '美国']]) {
      expect(located(orgCode, country!), `${orgCode} ${country}`).not.toHaveProperty('location');
    }
  });

  it("never places a scan at an airline's name", () => {
    const placed = (orgCode: string, orgName: string, receiverCountryName = '波兰') => parseChinaPostTraces(edit('customs', (mail) => {
      Object.assign(scan(mail, 2), { operationCode: '500', operation: '航空公司接收', stateDesc: '运送中', orgCode, orgName });
      mail.receiverCountryName = receiverCountryName;
    }), NUMBER).events?.[0];
    expect(placed('CF', '邮政航空')).toEqual({ ...china('2026-09-03T10:06:42'), description: 'Received by airline', provider_code: '500', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(placed('CF', '示例航空公司')).not.toHaveProperty('location');
    // Not even when the airline's code is also the destination's country code.
    expect(placed('CF', '邮政航空', '中非共和国')).not.toHaveProperty('location');
    expect(placed('CF', '', '中非共和国')).toMatchObject({ location: 'Central African Republic' });
    for (const office of ['HKG', '示例航空中心', '示例国际机场']) expect(placed('HKG', office)).toMatchObject({ location: office });
  });

  it('stages the arrival in the destination country and its import customs by their codes', () => {
    const scanned = (operationCode: string, operation: string) => parseChinaPostTraces(edit('customs', (mail) => {
      Object.assign(scan(mail, 2), { operationCode, operation, stateDesc: '运送中' });
    }), NUMBER).events?.[0];
    expect(scanned('516', '到达寄达地')).toMatchObject({ description: 'Arrive at the place of destination', stage: 'in_transit' });
    expect(scanned('486', '送交境外进口海关')).toMatchObject({ description: 'Presented to import customs abroad', stage: 'customs' });
    expect(scanned('493', '境外进口海关留存待验(等待提交给边境机构/安全部门)'))
      .toMatchObject({ description: 'Held by import customs abroad for inspection', stage: 'customs' });
  });

  it('keeps a delivery that destination offices scanned again afterwards', () => {
    // Oldest first, as the service sends them: out for delivery, delivered,
    // then the destination office of exchange's arrival scan, uploaded later.
    const late = (newer: Record<string, unknown>) => edit('delivered', (mail) => {
      mail.receiverCountryName = '哥伦比亚';
      mail.stateDesc = '到达境外目的地';
      mail.mailInfoCount = 27;
      Object.assign(scan(mail, 0), { operationCode: '462', operation: '【哥伦比亚】安排投递', stateDesc: '派送中', orgCode: 'CO', orgName: '哥伦比亚', time: '2026-08-26 08:04:00' });
      Object.assign(scan(mail, 1), { operationCode: '463', operation: '【哥伦比亚】已妥投', stateDesc: '已签收', orgCode: 'CO', orgName: '哥伦比亚', time: '2026-08-26 16:19:00' });
      Object.assign(scan(mail, 2), { operationCode: '459', operation: '到达寄达地处理中心', stateDesc: '到达境外目的地', orgCode: 'COBOGC', orgName: '', time: '2026-09-03 14:13:00', ...newer });
    });
    const result = parseChinaPostTraces(late({}), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update_local: '2026-09-03T14:13:00', destination_country: 'CO', history_truncated: true });
    expect(result.events?.slice(0, 3)).toEqual([
      { local_time: '2026-09-03T14:13:00', description: 'Arrival at processing center in the destination country', location: 'Colombia', provider_code: '459', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-08-26T16:19:00', description: 'Delivered', location: 'Colombia', provider_code: '463', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-08-26T08:04:00', description: 'Out for delivery', location: 'Colombia', provider_code: '462', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    for (const event of result.events ?? []) {
      expect(statusMap.stage(event.provider_code ?? null, normalizeStatusWording(event.description ?? '')), event.description).toBe(event.stage);
    }
    // The destination's other inbound processing codes count too, and so does an office named after the country.
    for (const operationCode of ['460', '461', '489']) {
      expect(parseChinaPostTraces(late({ operationCode }), NUMBER), operationCode).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    }
    expect(parseChinaPostTraces(late({ orgCode: '', orgName: '哥伦比亚' }), NUMBER)).toMatchObject({ status: 'delivered' });
    // Any other newer scan sets the status: a return, an attempt, another
    // delivery round, a scan outside the destination, export customs on the
    // way back, a code staged only by its state label, or one without a stage.
    for (const [newer, status, stage] of [
      [{ operationCode: '711', operation: '已退回', stateDesc: '已退回' }, 'exception', 'returned'],
      [{ operationCode: '542', operation: '已试投/投递失败', stateDesc: '运送中' }, 'exception', 'failed_attempt'],
      [{ operationCode: '462', operation: '【哥伦比亚】安排投递', stateDesc: '派送中' }, 'out_for_delivery', 'out_for_delivery'],
      [{ operationCode: '954', operation: '邮件到达【示例市国际互换局】', stateDesc: '运送中', orgCode: '00000001', orgName: '示例市国际互换局' }, 'in_transit', 'in_transit'],
      [{ orgCode: 'USJFKA' }, 'in_transit', 'in_transit'],
      [{ operationCode: 'EXA', operation: '送交出口海关', stateDesc: '清关中' }, 'in_transit', 'customs'],
      [{ operationCode: '999', operation: '进口海关/留存待验', stateDesc: '清关中' }, 'in_transit', 'customs'],
      [{ operationCode: '999', operation: '邮件处理', stateDesc: '运送中' }, 'in_transit', 'in_transit'],
      [{ operationCode: '999', operation: '邮件状态变更', stateDesc: '未知状态' }, 'in_transit', 'in_transit'],
    ] as const) {
      expect(parseChinaPostTraces(late(newer), NUMBER), JSON.stringify(newer)).toMatchObject({ status, current_stage: stage });
    }
    expect(parseChinaPostTraces(late({ operationCode: '999', operation: '邮件状态变更', stateDesc: '未知状态' }), NUMBER).last_status_text).toBe('邮件状态变更');
  });

  it("dates China Post's own scans abroad on China's clock and the destination post's by their place", () => {
    const result = dateLocalClocks('china-post', parseChinaPostTraces(edit('delivered', (mail) => {
      mail.receiverCountryName = '日本';
      mail.mailInfoCount = 5;
      // Oldest first: the landing, the arrival at the destination, its processing centre, its import customs, its round and its delivery.
      const base = scan(mail, 0);
      mail.mailInfos = [
        { ...base, operationCode: '505', operation: '飞机进港', stateDesc: '运送中', orgCode: '', orgName: '', time: '2026-09-01 05:00:00' },
        { ...base, operationCode: '516', operation: '到达寄达地', stateDesc: '到达境外目的地', orgCode: 'JP', orgName: '日本', time: '2026-09-01 07:55:00' },
        { ...base, operationCode: '459', operation: '到达寄达地处理中心', stateDesc: '到达境外目的地', orgCode: 'JP', orgName: '日本', time: '2026-09-01 23:04:00' },
        { ...base, operationCode: '486', operation: '送交境外进口海关', stateDesc: '清关中', orgCode: 'JP', orgName: '日本', time: '2026-09-02 08:59:00' },
        { ...base, operationCode: '493', operation: '境外进口海关留存待验(等待提交给边境机构/安全部门)', stateDesc: '清关中', orgCode: 'JP', orgName: '日本', time: '2026-09-02 09:00:00' },
        { ...base, operationCode: '487', operation: '寄达地海关允许进口', stateDesc: '运送中', orgCode: 'JP', orgName: '日本', time: '2026-09-02 17:03:00' },
        { ...base, operationCode: '460', operation: '离开【日本】处理中心', stateDesc: '运送中', orgCode: 'JP', orgName: '日本', time: '2026-09-02 17:04:00' },
        { ...base, operationCode: '462', operation: '【日本】安排投递', stateDesc: '派送中', orgCode: 'JP', orgName: '日本', time: '2026-09-03 08:30:00' },
        { ...base, operationCode: '463', operation: '【日本】已妥投', stateDesc: '已签收', orgCode: 'JP', orgName: '日本', time: '2026-09-03 13:10:00' },
      ];
    }), NUMBER));
    // The destination post's processing and customs scans match its own record to the minute.
    expect(result.events?.map((event) => [event.provider_code, event.time, event.time_zone_basis])).toEqual([
      ['463', '2026-09-03T13:10:00+09:00', 'place'],
      ['462', '2026-09-03T08:30:00+09:00', 'place'],
      ['460', '2026-09-02T17:04:00+09:00', 'place'],
      ['487', '2026-09-02T17:03:00+09:00', 'place'],
      ['493', '2026-09-02T09:00:00+09:00', 'place'],
      ['486', '2026-09-02T08:59:00+09:00', 'place'],
      ['459', '2026-09-01T23:04:00+09:00', 'place'],
      ['516', '2026-09-01T07:55:00+08:00', 'carrier'],
      ['505', '2026-09-01T05:00:00+08:00', 'carrier'],
    ]);
    expect(result.last_update).toBe('2026-09-03T13:10:00+09:00');
  });

  it('keeps the receiver country label when it has no ISO code', () => {
    const result = parseChinaPostTraces(edit('delivered', (mail) => { mail.receiverCountryName = '示例国'; }), NUMBER);
    expect(result.destination_country).toBeUndefined();
    expect(result.destination_country_name).toBe('示例国');
    const empty = parseChinaPostTraces(edit('delivered', (mail) => { mail.receiverCountryName = ''; }), NUMBER);
    expect(empty).not.toHaveProperty('destination_country');
    expect(empty).not.toHaveProperty('destination_country_name');
  });
});

describe('China Post scan text', () => {
  it.each([
    ['【日本】已妥投', '已签收', '【日本】已妥投'],
    ['离开【澳大利亚】处理中心', '到达境外目的地', '离开【澳大利亚】处理中心'],
    ['邮件离开【示例市国际互换局】，正在发往下一站', '运送中', '邮件离开【示例市国际互换局】'],
    ['邮件已乘机由【示例市】飞往【示例二市】', '已起飞', '邮件已乘机由【示例市】飞往【示例二市】'],
    ['邮件到达【示例市】，准备发往【示例航空中心】', '已落地', '邮件到达【示例市】'],
    ['邮件到达【示例航站包件车间】', '运送中', '邮件到达【示例航站包件车间】'],
    ['邮件到达【示例县】', '运送中', '邮件到达【示例县】'],
    ['邮件到达【示例花园小区】', '运送中', '运送中'],
    ['邮件到达【示例自治州】', '运送中', '邮件到达【示例自治州】'],
    ['已妥投【王州】', '已签收', '已签收'],
    ['已妥投【李省】', '已签收', '已签收'],
    ['已试投/投递失败(不可抗力/特殊事件/计划下一个工作日尝试后续操作/配送)', '运送中', '已试投/投递失败(不可抗力/特殊事件/计划下一个工作日尝试后续操作/配送)'],
    ['【示例市揽投部】已收寄，揽投员：PRIVATE，电话：10000000000', '已揽收', '【示例市揽投部】已收寄'],
    ['已妥投【PRIVATE】', '已签收', '已签收'],
    ['您的邮件已由本人签收', '已签收', '已签收'],
    ['投递员PRIVATE正在派送', '派送中', '派送中'],
    ['请联系13800000000', '派送中', '派送中'],
    ['邮件到达【示例市揽投部', '运送中', '运送中'],
    ['', '运送中', '运送中'],
    ['签收人：PRIVATE', '电话10000000000', ''],
  ])('reads %s', (operation, state, expected) => {
    expect(chinaPostDescription(operation, state)).toBe(expected);
  });

  it('maps Chinese country labels to ISO codes', () => {
    expect(['美国', '日本', '巴西', '新西兰', '澳大利亚', '印度', '波兰', '英国', '德国', '香港', '中国香港特别行政区'].map(chinaPostCountry))
      .toEqual(['US', 'JP', 'BR', 'NZ', 'AU', 'IN', 'PL', 'GB', 'DE', 'HK', 'HK']);
    expect(chinaPostCountry('欧盟')).toBeUndefined();
    expect(chinaPostCountry('未知地区')).toBeUndefined();
  });
});

describe('China Post check step', () => {
  it('opens the trace like the app', () => {
    expect(() => checkChinaPostGate(fixture('check-open'))).not.toThrow();
    expect(() => checkChinaPostGate({ code: '000000', info: 1, msg: 'SUCCESS' })).not.toThrow();
    expect(() => checkChinaPostGate({ code: '000000', info: 2, msg: 'SUCCESS' })).toThrow(expect.objectContaining({ kind: 'input_required' }));
    expect(() => checkChinaPostGate({ code: '000000', info: 3, msg: 'SUCCESS' })).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate' }));
    expect(() => checkChinaPostGate({ code: '000000', info: '5', msg: 'SUCCESS' })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => checkChinaPostGate(fixture('signature-refused'))).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each([
    ['no-information', 'indeterminate'],
    ['signature-refused', 'challenge'],
    ['trace-not-opened', 'indeterminate'],
  ])('answers the %s trace reply as %s, never as not found', (name, kind) => {
    expect(() => parseChinaPostTraces(fixture(name), NUMBER)).toThrow(expect.objectContaining({ kind }));
  });

  it.each([
    [{ code: '100001', msg: '请登录后再查询' }, 'challenge'],
    [{ code: '200001', msg: '' }, 'challenge'],
    [{ code: '200002', msg: 'FAIL' }, 'challenge'],
    [{ code: '999999', msg: '登录过期,请重新登录' }, 'challenge'],
    [{ code: '999999', msg: '登陆过期' }, 'challenge'],
    [{ code: '100001', msg: '服务繁忙,请稍后再试' }, 'indeterminate'],
    [{ code: '999999', msg: '其他' }, 'indeterminate'],
    [{ code: 100001, msg: '暂无物流信息' }, 'schema'],
    [[], 'schema'],
  ])('classifies %j as %s', (payload, kind) => {
    expect(() => parseChinaPostTraces(payload, NUMBER)).toThrow(expect.objectContaining({ kind }));
  });
});
