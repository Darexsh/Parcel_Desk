import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCdek } from '../carriers/cdek/parser.js';
import { confirmDsvShipment, pickDsvShipment } from '../carriers/dsv/parser.js';
import { parseDynalogic } from '../carriers/dynalogic/parser.js';
import { parseFanCourier } from '../carriers/fan-courier/parser.js';
import { parseGebruederWeiss } from '../carriers/gebrueder-weiss/parser.js';
import { parseGLSItaly } from '../carriers/gls-it/parser.js';
import { parseJdLogistics } from '../carriers/jd-logistics/parser.js';
import { parseKuehneNagelSearch } from '../carriers/kuehne-nagel/parser.js';
import { parseMatkahuolto } from '../carriers/matkahuolto/parser.js';
import { parsePassport } from '../carriers/passport/parser.js';
import { parseYto } from '../carriers/yto/parser.js';
import { parseYunda } from '../carriers/yunda/parser.js';

const text = (carrier: string, name: string) => readFileSync(new URL(`../carriers/${carrier}/fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (carrier: string, name: string) => JSON.parse(text(carrier, name));
// Display limits used to erase these separators and the different identifier after them.
const longer = (number: string) => number + '-'.repeat(128) + 'DIFFERENT999';

describe('returned shipment identity', () => {
  it('does not mistake a truncated DSV id or house bill for a whole-number match', () => {
    const payload = fixture('dsv', 'search-road.json');
    const number = payload.data[0].bookingId;
    expect(pickDsvShipment(payload, number).own).toBe(true);
    payload.data[0].bookingId = longer(number);
    expect(pickDsvShipment(payload, number).own).toBe(false);
    expect(() => confirmDsvShipment({ houseBillNumber: longer(number) }, number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    payload.data[0].bookingId = number;
    payload.data[0].randomIdentifier = 'A'.repeat(81);
    expect(() => pickDsvShipment(payload, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['gls-it', 'matkahuolto', 'cdek', 'fan-courier', 'dynalogic', 'gebrueder-weiss', 'yto', 'yunda'])(
    '%s compares the complete returned identifier', carrier => {
      const payload = fixture(carrier, carrier === 'matkahuolto' ? 'collected.json' : carrier === 'cdek' ? 'courier.json' : 'delivered.json');
      let number: string;
      let run: () => unknown;
      let corrupt: () => void;
      switch (carrier) {
        case 'gls-it':
          number = payload.tuStatus[0].tuNo; run = () => parseGLSItaly(payload, number);
          corrupt = () => { payload.tuStatus[0].tuNo = longer(number); }; break;
        case 'matkahuolto':
          number = payload.parcelNumber; run = () => parseMatkahuolto(payload, number);
          corrupt = () => { payload.parcelNumber = longer(number); }; break;
        case 'cdek':
          number = payload.orderNumber; run = () => parseCdek(payload, number);
          corrupt = () => { payload.data.orderNumber = longer(number); }; break;
        case 'fan-courier':
          number = payload.awbNumber; run = () => parseFanCourier(payload, number);
          corrupt = () => { payload.awbNumber = longer(number); }; break;
        case 'dynalogic':
          number = payload.data.TrackAndTraceNumber; run = () => parseDynalogic(payload, number);
          corrupt = () => { payload.data.TrackAndTraceNumber = longer(number); }; break;
        case 'gebrueder-weiss':
          number = payload.payload[0].order_id; run = () => parseGebruederWeiss(payload, number);
          corrupt = () => { payload.payload[0].order_id = longer(number); }; break;
        case 'yto':
          number = payload[0].waybillNo; run = () => parseYto(payload, number);
          corrupt = () => { payload[0].waybillNo = longer(number); }; break;
        case 'yunda':
          number = Object.keys(payload.data.order)[0]!; run = () => parseYunda(payload, number);
          corrupt = () => { payload.data.logistic[number].gn[0].mailNo = longer(number); }; break;
        default: throw new Error('Unknown regression fixture');
      }
      expect(run).not.toThrow();
      corrupt();
      expect(run).toThrow(expect.objectContaining({ kind: expect.stringMatching(/^(?:schema|indeterminate)$/) }));
    });

  it('keeps Kuehne+Nagel canonical numbers whole and refuses excessive identifiers', () => {
    const payload = fixture('kuehne-nagel', 'search-found.json');
    const row = payload.searchResultsByType[0].shipments[0];
    const number = row.trackingNumber;
    row.trackingNumber = longer(number);
    expect(parseKuehneNagelSearch(payload, number).trackingNumber).toBe(number + 'DIFFERENT999');
    row.trackingNumber = number + '-'.repeat(128) + 'X'.repeat(41);
    expect(() => parseKuehneNagelSearch(payload, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a longer JD parent identifier before reading its pieces', () => {
    const number = 'JD0000000000001';
    expect(() => parseJdLogistics({ code: 1, data: [{ waybillNo: longer(number) }] }, number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a longer Passport shipment identifier in the page configuration', () => {
    const html = text('passport', 'delivered.html');
    const number = /"tracking_code"\s*:\s*"([^"]+)"/.exec(html)![1]!;
    expect(() => parsePassport(html, number)).not.toThrow();
    const changed = html.replace(/("tracking_code"\s*:\s*")([^"]+)/, (_all, prefix: string) => prefix + longer(number));
    expect(() => parsePassport(changed, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
