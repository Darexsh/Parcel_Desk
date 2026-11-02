// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeSpeeDeeNumber, parseSpeeDee } from './parser.js';
import { speeDeeActivity, speeDeeStatus } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SP000000000000000017';
const SHORT = 'SP0000000000000017';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered.html');
const REUSED = fixture('reused.html');
const UNKNOWN = fixture('unknown.html');
// The progress table's body; the comment's sample table has no whitespace after its tbody.
const PROGRESS_BODY = /<tbody>\s+<tr class="odd">[\s\S]*<\/tbody>/;
const rows = (result: ReturnType<typeof parseSpeeDee>) => result.events?.map(({ local_time, description, location, stage, stage_source }) =>
  [local_time, description, location, stage, stage_source]);

describe('Spee-Dee barcodes', () => {
  it('takes SP and 16 or 18 digits', () => {
    expect(normalizeSpeeDeeNumber(' sp 0000 0000 0000 0000 17 ')).toBe(NUMBER);
    expect(normalizeSpeeDeeNumber('sp0000000000000017')).toBe(SHORT);
    for (const number of ['', 'SP123', 'SP00000000000000017', 'SP0000000000000000017', 'SPX000000000000000017',
      '000000000000000017', 'SP00000000000000001A', `SP${'0'.repeat(70)}`]) {
      expect(() => normalizeSpeeDeeNumber(number)).toThrow(InvalidInputError);
    }
  });
});

describe('Spee-Dee package progress', () => {
  it('reads the progress table as local wall clocks, newest first', () => {
    const result = normalizeCarrierResult(parseSpeeDee(DELIVERED, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-03-09T14:15:00', expected_delivery: null });
    expect(rows(result)).toEqual([
      ['2026-03-09T14:15:00', 'Delivered', 'EXAMPLE CITY, IL', 'delivered', 'carrier_map'],
      ['2026-03-09T08:02:41', 'OUT FOR DELIVERY', 'SAMPLE HUB, IL', 'out_for_delivery', 'carrier_map'],
      ['2026-03-09T05:40:00', 'ARRIVAL SCAN', 'SAMPLE HUB, IL', 'in_transit', 'carrier_map'],
      ['2026-03-08T23:58:12', 'ARRIVAL SCAN', 'MIDWAY DEPOT, WI', 'in_transit', 'carrier_map'],
      ['2026-03-07T16:05:55', 'ARRIVAL SCAN', 'ORIGIN TERMINAL, MN', 'in_transit', 'carrier_map'],
    ]);
    // No offset is invented for the wall clocks, and no zone is declared.
    expect(result.events?.every((event) => event.time === undefined)).toBe(true);
    expect(result.timezone).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(['current_stage', 'current_stage_source', 'events', 'expected_delivery',
      'last_status_text', 'last_update', 'last_update_local', 'status']);
  });

  it('never reads the comments, the signer, the address or the route', () => {
    const result = JSON.stringify(parseSpeeDee(DELIVERED, NUMBER));
    expect(result).not.toMatch(/PRIVATE|00000\)|SP000000000000000025|1700000000|Signed|Delivered to/);
    // A comment that never closes is dropped too.
    const unclosed = DELIVERED.replace(/ -->/, '');
    expect(() => parseSpeeDee(unclosed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(JSON.stringify(parseSpeeDee(DELIVERED.replace('<!-- Array', '<!-- PRIVATE <!-- Array'), NUMBER))).not.toContain('PRIVATE');
  });

  it('keeps only the shipment since the previous delivery of a reused barcode', () => {
    const result = parseSpeeDee(REUSED, SHORT);
    expect(rows(result)).toEqual([
      ['2026-05-12T10:20:00', 'Delivered', 'EXAMPLE CITY, IL', 'delivered', 'carrier_map'],
      ['2026-05-12T07:45:10', 'OUT FOR DELIVERY', 'SAMPLE HUB, IL', 'out_for_delivery', 'carrier_map'],
      ['2026-05-11T21:30:00', 'ARRIVAL SCAN', 'SAMPLE HUB, IL', 'in_transit', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/2023|OTHER/);
  });

  it('cuts at the first delivery when the newest shipment is still moving', () => {
    const undelivered = REUSED.replace(/<tr class="odd">\s*<td>05\/12\/2026 10:20:00 am<\/td>[\s\S]*?<\/tr>/, '');
    // The summary may still describe the earlier delivery, or already the new shipment.
    for (const moving of [
      undelivered.replace('<td>05/12/2026 10:20 am</td>', '<td>08/14/2023 01:10 pm</td>'),
      undelivered.replace('<td>Delivered</td>\n\t\t</tr>', '<td>In Transit</td>\n\t\t</tr>'),
    ]) {
      const result = parseSpeeDee(moving, SHORT);
      expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update_local: '2026-05-12T07:45:10' });
      expect(result.events).toHaveLength(2);
      expect(JSON.stringify(result)).not.toMatch(/2023|OTHER/);
    }
  });

  it('cuts at a back-to-back delivery a day or more older', () => {
    const newest = /<tr class="odd">\s*<td>05\/12\/2026 10:20:00 am<\/td>[\s\S]*?<\/tr>/.exec(REUSED)![0];
    const previous = newest.replace('05/12/2026 10:20:00 am', '05/11/2026 10:20:00 am').replace('EXAMPLE CITY', 'OTHER CITY');
    const result = parseSpeeDee(REUSED.replace(newest, `${newest}${previous}`), SHORT);
    expect(rows(result)).toEqual([['2026-05-12T10:20:00', 'Delivered', 'EXAMPLE CITY, IL', 'delivered', 'carrier_map']]);
  });

  it('is inconclusive when the summary is not about the newest scans', () => {
    const newest = /<tr class="odd">\s*<td>03\/09\/2026 02:15:00 pm<\/td>[\s\S]*?<\/tr>/.exec(DELIVERED)![0];
    const undelivered = DELIVERED.replace(newest, '');
    for (const page of [
      DELIVERED.replace('<td>Delivered</td>\n\t\t</tr>', '<td>In Transit</td>\n\t\t</tr>'),
      DELIVERED.replace('<td>03/09/2026 02:15 pm</td>', '<td>03/09/2026 02:16 pm</td>'),
      DELIVERED.replace('<td>03/09/2026 02:15 pm</td>', '<td></td>'),
      // A delivery the progress table does not show, or does not date.
      undelivered,
      undelivered.replace('<td>03/09/2026 02:15 pm</td>', '<td>03/09/2026 08:02 am</td>'),
      undelivered.replace(/<tr valign="top">\s*<td class="text-right"><strong class="nowrap">Delivered on:[\s\S]*?<\/tr>/, ''),
    ]) expect(() => parseSpeeDee(page, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    // Without a "Delivered on" row, the status alone has to agree.
    const undated = DELIVERED.replace(/<tr valign="top">\s*<td class="text-right"><strong class="nowrap">Delivered on:[\s\S]*?<\/tr>/, '');
    expect(parseSpeeDee(undated, NUMBER).status).toBe('delivered');
  });

  it('binds the page to the whole requested barcode', () => {
    expect(() => parseSpeeDee(DELIVERED, 'SP000000000000000025')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpeeDee(DELIVERED, SHORT)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSpeeDee(REUSED, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const page of [
      DELIVERED.replace(`<td>${NUMBER}                    </td>`, '<td>SP000000000000000025</td>'),
      DELIVERED.replace(`</strong> ${NUMBER}</p>`, '</strong> SP000000000000000025</p>'),
      DELIVERED.replace(`<p><strong>Tracking Number:</strong> ${NUMBER}</p>`, ''),
      DELIVERED.replace(/<tr valign="top">\s*<td class="text-right"><strong class="nowrap">Tracking Number:[\s\S]*?<\/tr>/, ''),
      DELIVERED.replace('<h3>Package Progress</h3>', `<h3>Package Progress</h3><p><strong>Tracking Number:</strong> ${NUMBER}</p>`),
      DELIVERED.replace('<h3>Package Progress</h3>', '<h3>Package Progress for SP000000000000000025</h3>'),
      DELIVERED.replace('<td>MIDWAY DEPOT, WI</td>', '<td>MIDWAY DEPOT, WI SP0000000000000025</td>'),
      // However far down the page another barcode sits.
      DELIVERED.replace('</body>', `<p>${'x '.repeat(150_000)}SP0000000000000025</p></body>`),
      `${DELIVERED}${DELIVERED}`,
    ]) expect(() => parseSpeeDee(page, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('answers the exact not-found page as not found, and nothing else', () => {
    expect(() => parseSpeeDee(UNKNOWN, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found', status: 404 }));
    for (const page of [
      UNKNOWN.replace('No packages were found', 'No package was found'),
      `${UNKNOWN}<table><tr><td>${NUMBER}</td></tr></table>`,
      DELIVERED.replace('<h3>Package Progress</h3>', '<p>No packages were found matching the barcode supplied.</p>'),
      '<html><body>Service temporarily unavailable</body></html>',
      '',
    ]) expect(() => parseSpeeDee(page, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports a challenge page as a challenge, even when it mentions not-found text', () => {
    for (const page of [
      '<html><head><title>Just a moment...</title></head><body>cf-chl-widget</body></html>',
      '<html><head><title>Access Denied</title></head><body>No packages were found matching the barcode supplied.</body></html>',
      '<html><body><div class="g-recaptcha"></div></body></html>',
    ]) expect(() => parseSpeeDee(page, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    // A captcha or bot-detection script next to the package does not hide it.
    for (const script of ['https://www.google.com/recaptcha/api.js', '/cdn-cgi/challenge-platform/scripts/jsd/main.js']) {
      const scripted = DELIVERED.replace('</body>', `<script src="${script}"></script></body>`);
      expect(parseSpeeDee(scripted, NUMBER).events).toHaveLength(5);
    }
    // Nor does such a script make a changed page a challenge.
    const changed = '<html><head><title>Error</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body>Database error</body></html>';
    expect(() => parseSpeeDee(changed, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects a changed progress table instead of reading part of it', () => {
    for (const page of [
      DELIVERED.replaceAll('<th>Activity</th>', '<th>Event</th>'),
      DELIVERED.replace('03/08/2026 11:58:12 pm', '2026-03-08 23:58:12'),
      DELIVERED.replace('03/08/2026 11:58:12 pm', '02/30/2026 11:58:12 pm'),
      DELIVERED.replace('03/08/2026 11:58:12 pm', '03/08/2026 13:58:12 pm'),
      DELIVERED.replace('<td>MIDWAY DEPOT, WI</td>', ''),
      DELIVERED.replace('<td>OUT FOR DELIVERY (00000)</td>', '<td> </td>'),
      DELIVERED.replace(/<tr valign="top">\s*<td style="width:130px;" class="text-right"><strong class="nowrap">Status:<\/strong><\/td>\s*<td>Delivered<\/td>\s*<\/tr>/, ''),
      DELIVERED.replace('<strong class="nowrap">Signed by:</strong>', '<strong class="nowrap">Status:</strong>'),
      DELIVERED.replace(PROGRESS_BODY, `<tbody>${'<tr><td>03/07/2026 04:05:55 pm</td><td>X, IL</td><td>ARRIVAL SCAN</td></tr>'.repeat(501)}</tbody>`),
    ]) expect(() => parseSpeeDee(page, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const empty = DELIVERED.replace(PROGRESS_BODY, '<tbody></tbody>');
    expect(() => parseSpeeDee(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('drops exact duplicate rows and keeps seconds-free clocks', () => {
    const row = /<tr class="even">\s*<td>03\/09\/2026 08:02:41 am<\/td>[\s\S]*?<\/tr>/.exec(DELIVERED)![0];
    const result = parseSpeeDee(DELIVERED.replace(row, `${row}${row}`).replace('03/07/2026 04:05:55 pm', '03/07/2026 4:05 PM'), NUMBER);
    expect(result.events).toHaveLength(5);
    expect(result.events?.at(-1)?.local_time).toBe('2026-03-07T16:05:00');
  });

  it('does not take a repeated delivery row for an earlier shipment', () => {
    const row = /<tr class="odd">\s*<td>03\/09\/2026 02:15:00 pm<\/td>[\s\S]*?<\/tr>/.exec(DELIVERED)![0];
    const result = parseSpeeDee(DELIVERED.replace(row, `${row}${row}`), NUMBER);
    expect(rows(result)).toEqual(rows(parseSpeeDee(DELIVERED, NUMBER)));
    expect(result.events).toHaveLength(5);
    // A delivery scanned again minutes later is the same delivery.
    const rescanned = parseSpeeDee(DELIVERED.replace(row, `${row}${row.replace('02:15:00 pm', '02:14:10 pm')}`), NUMBER);
    expect(rescanned.events).toHaveLength(6);
    expect(rescanned.events?.slice(0, 2).map((event) => event.local_time)).toEqual(['2026-03-09T14:15:00', '2026-03-09T14:14:10']);
  });

  it('maps only the activities seen live and leaves other wording to the shared classifier', () => {
    for (const entry of statuses.entries) expect(speeDeeStatus(speeDeeActivity(entry.wording))?.stage).toBe(entry.stage);
    expect(speeDeeActivity('OUT FOR DELIVERY (12345)')).toBe('OUT FOR DELIVERY');
    expect(speeDeeActivity('Out for delivery (PRIVATE NAME)')).toBe('OUT FOR DELIVERY');
    expect(speeDeeActivity('ARRIVAL SCAN (00000)')).toBe('ARRIVAL SCAN (00000)');
    for (const wording of ['PICKED UP', 'In transit', 'DRIVER DISPATCHED']) {
      const page = DELIVERED.replace('<td>Delivered</td>\n\t\t\t</tr>', `<td>${wording}</td>\n\t\t\t</tr>`)
        .replace('<td>Delivered</td>\n\t\t</tr>', `<td>${wording}</td>\n\t\t</tr>`);
      const result = parseSpeeDee(page, NUMBER);
      expect(result).toMatchObject({ status: 'unknown', last_status_text: wording });
      expect(result.current_stage).toBeUndefined();
      expect(result.events?.[0]?.stage).toBeUndefined();
      expect(result.events?.[0]?.stage_source).toBeUndefined();
    }
  });

  it('proves each declared capability with a synthetic page', () => {
    const result = parseSpeeDee(DELIVERED, NUMBER);
    const checks: Record<string, boolean> = { history: Boolean(result.events?.length),
      location: Boolean(result.events?.some((event) => event.location)) };
    const capabilities = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')).capabilities as string[];
    for (const capability of capabilities) expect(checks[capability], capability).toBe(true);
  });
});
