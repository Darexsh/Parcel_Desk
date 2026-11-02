import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeZoomNumber, parseZoom, validateZoomResultUrl, zoomTrackingUrl } from './parser.js';
import { statusMap, zoomStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '4057319826', OTHER = '4068291735';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const parse = (html = fixture(), url = zoomTrackingUrl(NUMBER)) => parseZoom(html, NUMBER, url);

describe('Zoom result parser', () => {
  it('reads the exact guia, deduplicates scans and keeps local table clocks without recipient details', () => {
    const result = parse();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO AL CLIENTE', last_update: null, last_update_local: '2026-10-30T13:03:00', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events![0]).toEqual({ local_time: '2026-10-30T13:03:00', description: 'ENTREGADO AL CLIENTE',
      location: 'CIUDAD INVENTADA · TAQUILLA DE PRUEBA', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'in_transit', 'in_transit', 'accepted', 'registered']);
    const output = JSON.stringify(result);
    for (const privateText of [NUMBER, 'SENDER-SYNTHETIC', 'RECIPIENT-SYNTHETIC', 'PRIVATE-ORDER-REFERENCE', 'PRIVATE-AMOUNT', '12:27']) expect(output).not.toContain(privateText);
    expect(result.events!.every(event => !event.time && !event.provider_code)).toBe(true);
  });

  it('does not let a future rail milestone complete an item held for collection', () => {
    const html = fixture().replace(/<tr><td class="nro-fila">7<\/td>[\s\S]*?<\/tr>/, '');
    expect(parse(html)).toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('requires the whole number in the title and the summary independently', () => {
    for (const html of [fixture().replace(`Envío ${NUMBER}`, `Envío ${OTHER}`),
      fixture().replace(`<td>${NUMBER}</td>`, `<td>${OTHER}</td>`), fixture().replace(`Envío ${NUMBER}`, `Envío ${NUMBER}7`)]) {
      expect(() => parse(html)).toThrow(expect.objectContaining({ kind: expect.stringMatching(/indeterminate|schema/) }));
    }
  });

  it('binds final browser and verified HTTP results to the complete query, without retaining the token', () => {
    const url = `${zoomTrackingUrl(NUMBER)}&turnstile-token=SYNTHETIC-ONE-USE-RESPONSE`;
    expect(parse(fixture(), url).current_stage).toBe('delivered');
    expect(JSON.stringify(parse(fixture(), url))).not.toContain('SYNTHETIC-ONE-USE-RESPONSE');
    for (const bad of [zoomTrackingUrl(OTHER), `${url}&nro-guia=${OTHER}`, `${zoomTrackingUrl(NUMBER)}&tipo-consulta=2`]) {
      expect(() => validateZoomResultUrl(bad, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const bad of ['https://other.invalid/', zoomTrackingUrl(NUMBER).replace('/tracking-de-envios-personas/', '/'),
      `${zoomTrackingUrl(NUMBER)}&turnstile-token=one&turnstile-token=two`, `${zoomTrackingUrl(NUMBER)}&unrelated=1`]) {
      expect(() => validateZoomResultUrl(bad, NUMBER)).toThrow(expect.objectContaining({ kind: 'transport' }));
    }
  });

  it('accepts only the complete explicit negative notice on the bound route', () => {
    expect(() => parse(fixture('not-found'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(fixture('not-found'), zoomTrackingUrl(OTHER))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture('not-found').replace('No se ha encontrado el tracking asociado.', 'Servicio temporalmente no disponible.')))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(fixture('not-found').replace('</div></div>', '<table></table></div></div>')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps verification failures as challenges, including a late response in a large HTML page', () => {
    const rejection = fixture('not-found').replace('No se ha encontrado el tracking asociado.', 'No se pudo validar la identidad del usuario');
    expect(() => parse(rejection)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse(' '.repeat(70_000) + rejection)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse('<html><body><div class="cf-turnstile"><input name="cf-turnstile-response" value=""></div></body></html>'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('anchors two-digit event years to creation, including a century rollover', () => {
    let html = fixture().replace('28/10/2026', '31/12/2099');
    html = html.replaceAll('30/10/26', '02/01/00').replaceAll('29/10/26', '01/01/00').replaceAll('28/10/26', '31/12/99');
    const result = parse(html);
    expect(result.last_update_local).toBe('2100-01-02T13:03:00');
    expect(result.events!.at(-1)!.local_time).toBe('2099-12-31T09:25:00');
  });

  it.each(['31/02/26', '29/02/25', '2026-10-30', '30/10/2026'])('rejects invalid scan day %s', day => {
    expect(() => parse(fixture().replace('30/10/26', day))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['24:00', '13:99', '13:03:21', ''])('rejects invalid table clock %s', clock => {
    expect(() => parse(fixture().replace('>13:03<', `>${clock}<`))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['31/02/2026', '28/10/26', ''])('rejects invalid creation anchor %s', day => {
    expect(() => parse(fixture().replace('28/10/2026', day))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps different facility scans and stages unknown wording conservatively', () => {
    const html = fixture().replace('RECIBIDO EN LA TAQUILLA DESTINO</td><td class="ciudad">CIUDAD INVENTADA',
      'RECIBIDO EN LA TAQUILLA DESTINO</td><td class="ciudad">OTRA CIUDAD');
    expect(parse(html).events).toHaveLength(7);
    const unknown = parse(fixture().replace('ENTREGADO AL CLIENTE: RECIPIENT-SYNTHETIC | 30/10/26 12:27', 'NOVEDAD SIN CLASIFICAR'));
    expect(unknown.events![0]).toMatchObject({ description: 'NOVEDAD SIN CLASIFICAR' });
    expect(unknown.events![0]!.stage).toBeUndefined();
    expect(zoomStage('NOVEDAD SIN CLASIFICAR')).toBeNull();
  });

  it('rejects changed columns, repeated summary keys and missing tables instead of inventing history', () => {
    for (const html of [fixture().replace('<th>Oficina</th>', '<th>Otro campo</th>'), fixture().replace('MONTO A COBRAR:', 'N° DE GUÍA:'),
      fixture().replace('class="zappi-trk-estados-tabla"', 'class="other-layout"')]) {
      expect(() => parse(html)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('bounds the response rows before duplicate filtering', () => {
    const row = /<tr><td class="nro-fila">7<\/td>[\s\S]*?<\/tr>/.exec(fixture())![0];
    const html = fixture().replace('</tbody>\n  </table></div>', `${row.repeat(501)}</tbody>\n  </table></div>`);
    expect(() => parse(html)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(statuses.entries)('maps the recorded wording $wording', entry => {
    expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
  });

  it('normalizes its accepted input without claiming ownership from its format', () => {
    expect(normalizeZoomNumber(' 4057-319826 ')).toBe(NUMBER);
    for (const invalid of ['405731982', NUMBER + '7', 'AB' + NUMBER, NUMBER + OTHER]) {
      expect(() => normalizeZoomNumber(invalid)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});
