import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeTccNumber, parseTcc, tccJson } from './parser.js';
import { statusMap, TCC_DELIVERED_WORDING } from './status.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = fixture().remesas.remesa[0].numeroremesa as string;
const shipment = (body: ReturnType<typeof fixture>) => body.remesas.remesa[0];

describe('TCC secondary history parser', () => {
  it('projects the same whole remesa, dated novelty and completed delivery without free observations', () => {
    const result = parseTcc(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', history_truncated: true,
      last_update: '2034-02-06T10:36:35.123-05:00', expected_delivery: null, events: [
        { description: TCC_DELIVERED_WORDING, stage: 'delivered', time: '2034-02-06T10:36:35.123-05:00' },
        { provider_code: '766', stage: 'in_transit', time: '2034-02-03T22:23:00.000-05:00' },
      ] });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC PRIVATE');
    expect(JSON.stringify(result)).not.toContain('codigonovedad');
    expect(JSON.stringify(result)).not.toContain(NUMBER);
  });

  it('accepts an exact safe numeric identity but never truncates one', () => {
    const body = fixture(); shipment(body).numeroremesa = Number(NUMBER);
    expect(parseTcc(body, NUMBER).events).toHaveLength(2);
    shipment(body).numeroremesa = `${NUMBER}7`;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([null, {}, [], true, Number.MAX_SAFE_INTEGER + 1])('rejects non-scalar or unsafe shipment identity %j', value => {
    const body = fixture(); shipment(body).numeroremesa = value;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([null, { remesa: [] }])('keeps empty or expired success histories inconclusive', remesas => {
    const body = fixture(); body.remesas = remesas;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects several response remesas without combining their completion', () => {
    const body = fixture(); body.remesas.remesa.push({ ...shipment(body), numeroremesa: '857164208' });
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads dated official history rows and deduplicates the same novelty from both lists', () => {
    const body = fixture(), one = shipment(body), novelty = one.novedades.novedad[0];
    one.estados = { estado: [{ descripcion: novelty.descripcion, fecha: novelty.fecha },
      { descripcion: TCC_DELIVERED_WORDING, fecha: one.fechaentrega }] };
    const result = parseTcc(body, NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events![1]).toMatchObject({ provider_code: '766', stage: 'in_transit' });
  });

  it('retains the carrier timestamp offsets and fractional precision while ordering by the instant', () => {
    const body = fixture(), one = shipment(body);
    one.fechaentrega = '2034-02-04T04:00:01.456789Z';
    one.novedades.novedad[0].fecha = '2034-02-03T23:00:00.123-05:00';
    const result = parseTcc(body, NUMBER);
    expect(result.events![0]!.time).toBe('2034-02-04T04:00:01.456789Z');
    expect(result.events![1]!.time).toBe('2034-02-03T23:00:00.123-05:00');
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
  });

  it.each(['2034-02-30T22:23:00.000-05:00', '2034-02-03T22:23:00', '2034-02-03T24:23:00Z', '2034-02-03T22:23:00+15:00', {}, null])('rejects invalid or offsetless scan clock %j', fecha => {
    const body = fixture(); shipment(body).novedades.novedad[0].fecha = fecha;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the top dated novelty only when its list is absent and does not treat its row id as a status code', () => {
    const body = fixture(); shipment(body).novedades = null;
    const result = parseTcc(body, NUMBER);
    expect(result.events).toHaveLength(2);
    expect(result.events![1]!.provider_code).toBeUndefined();
    expect(result.events![1]!.stage).toBe('in_transit');
  });

  it('retains an unresolved failed delivery without confusing its resolution with completion', () => {
    const body = fixture(), one = shipment(body);
    one.pasoestado = '5'; one.fechaentrega = null;
    one.novedades.novedad[0] = { codigo: '252', fecha: '2034-02-03T22:23:00.000-05:00',
      descripcion: 'MERCANCÍA NO ENTREGADA A DESTINATARIO - NO SE ENCUENTRA EL DESTINATARIO O NO HAY NADIE EN LA DIRECCIÓN', estado: 'Planteada' };
    const result = parseTcc(body, NUMBER);
    expect(result).toMatchObject({ current_stage: 'failed_attempt', history_truncated: true, events: [{ stage: 'failed_attempt', provider_code: '252' }] });
  });

  it('does not create scans for an undated future progress rail', () => {
    const body = fixture(), one = shipment(body);
    one.pasoestado = '4'; one.fechaentrega = '2034-02-28T12:00:00.000-05:00';
    const result = parseTcc(body, NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(result.events).toHaveLength(1);
    expect(result.events!.some(event => event.stage === 'delivered')).toBe(false);
  });

  it('does not invent a delivery time from a progress position or accept a later contradictory failure', () => {
    const body = fixture(); shipment(body).fechaentrega = null;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    shipment(body).fechaentrega = '2034-02-02T12:00:00.000-05:00';
    shipment(body).novedades.novedad[0].codigo = '252';
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a verified identity with no dated activity inconclusive', () => {
    const body = fixture(), one = shipment(body);
    one.pasoestado = '1'; one.novedad = null; one.fechanovedad = null; one.novedades = null;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it.each([{ estado: {} }, [], 'changed'])('rejects changed history list shapes %j', estados => {
    const body = fixture(); shipment(body).estados = estados;
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([{ descripcion: {} }, { fecha: 'invalid' }, { codigo: {} }, { estado: {} }])('rejects invalid history scalars %j', extra => {
    const body = fixture(); Object.assign(shipment(body).novedades.novedad[0], extra);
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('bounds the history size', () => {
    const body = fixture(), one = shipment(body); one.novedades.novedad = Array(501).fill(one.novedades.novedad[0]);
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each([{}, { respuesta: {} }, { respuesta: { codigo: {} } }, { respuesta: { codigo: '0' }, remesas: {} }])('rejects malformed envelopes %j', body => {
    expect(() => parseTcc(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps upstream refusals distinct from absence without retaining their messages', () => {
    expect(() => parseTcc({ respuesta: { codigo: '7', mensaje: 'invalid captcha SYNTHETIC PRIVATE' } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge', message: expect.not.stringContaining('SYNTHETIC PRIVATE') }));
    expect(() => parseTcc({ respuesta: { codigo: '2', mensaje: 'SYNTHETIC PRIVATE' } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: expect.not.stringContaining('SYNTHETIC PRIVATE') }));
  });

  it.each(['', '<html>Changed endpoint</html>', '<html><title>Just a moment...</title></html>'])('classifies non-JSON without retaining its body', body => {
    expect(() => tccJson(body)).toThrow(expect.objectContaining({ kind: body.includes('Just a moment') ? 'challenge' : 'schema' }));
  });

  it.each(['8571642097', 'AB857164209', '857164209,857164208', '<857164209>', 'https://tcc.com.co/rastreo/'])('rejects unsupported whole input %s', input => {
    expect(() => normalizeTccNumber(input)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('keeps mapped novelty codes separate from summary progress positions', () => {
    expect(statusMap.stage('252', '')).toBe('failed_attempt');
    expect(statusMap.stage('766', '')).toBe('in_transit');
    expect(statusMap.stage('6', 'New novelty wording')).toBeUndefined();
    expect(statusMap.stage(null, TCC_DELIVERED_WORDING)).toBe('delivered');
  });
});
