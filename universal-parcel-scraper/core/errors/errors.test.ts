import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError, CarrierError, ChallengeError, IndeterminateError, InputRequiredError, InvalidInputError, MaintenanceError,
  NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError,
  carrierErrorKind, errorTypeOf, retryAfterMsOf, writtenAheadClocks,
} from './index.js';
import { failureHint, failureKind } from './hint.js';

describe('carrier error taxonomy', () => {
  it('gives every kind a stable name, kind and HTTP-like status', () => {
    expect(new NotFoundError('CTT')).toMatchObject({ name: 'NotFoundError', kind: 'not_found', status: 404, provider: 'CTT' });
    expect(new IndeterminateError('Colisweb')).toMatchObject({ kind: 'indeterminate', status: 502 });
    // Routing reads no history as an indeterminate answer; only the health samples tell it apart.
    expect(new NoHistoryError('ParcelsApp')).toMatchObject({ name: 'NoHistoryError', kind: 'indeterminate', status: 502 });
    expect(new NoHistoryError('ParcelsApp')).toBeInstanceOf(IndeterminateError);
    expect(new ChallengeError('UPS')).toMatchObject({ kind: 'challenge', status: 403 });
    expect(new RateLimitedError('Ship24', 30_000)).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 30_000 });
    expect(new MaintenanceError('CTT')).toMatchObject({ kind: 'maintenance', status: 503 });
    expect(new SchemaError('DHL').status).toBeUndefined();
    expect(new InputRequiredError('Heppner', 'the delivery postcode')).toMatchObject({ kind: 'input_required', field: 'the delivery postcode' });
    expect(new InputRequiredError('Heppner', 'postcode').carrier).toBeUndefined();
    // A universal provider names the carrier whose gate it relays.
    expect(new InputRequiredError('ParcelsApp', 'postcode', undefined, { carrier: 'seur' }))
      .toMatchObject({ kind: 'input_required', field: 'postcode', carrier: 'seur', message: 'ParcelsApp tracking requires postcode' });
    expect(new InvalidInputError('La Poste')).toMatchObject({ name: 'InvalidInputError', kind: 'invalid_input', status: 400 });
    expect(new TransportError('DPD')).toMatchObject({ kind: 'transport' });
    expect(new BudgetExceededError('dhl', 5_000).message).toContain('5000 ms budget');
  });

  it('derives the kind of HTTP errors from their status', () => {
    expect(new UpstreamHttpError('La Poste', 404).kind).toBe('not_found');
    expect(new UpstreamHttpError('La Poste', 429, 1_000).kind).toBe('rate_limited');
    expect(new UpstreamHttpError('La Poste', 403).kind).toBe('challenge');
    expect(new UpstreamHttpError('La Poste', 503).kind).toBe('maintenance');
    expect(new UpstreamHttpError('La Poste', 500).kind).toBe('indeterminate');
    expect(new UpstreamHttpError('La Poste', 418).kind).toBe('transport');
    expect(new UpstreamHttpError('La Poste', 404).name).toBe('UpstreamHttpError');
    expect(new UpstreamNetworkError('La Poste', new Error('ECONNRESET'))).toMatchObject({ kind: 'transport', name: 'UpstreamNetworkError' });
  });

  it('classifies through cause chains and ignores unrelated errors', () => {
    const wrapped = new Error('sync failed', { cause: new Error('adapter failed', { cause: new NotFoundError('CTT') }) });
    expect(carrierErrorKind(wrapped)).toBe('not_found');
    expect(carrierErrorKind(new TypeError('bad payload'))).toBeNull();
    expect(carrierErrorKind('string')).toBeNull();
    const rateLimited = new Error('outer', { cause: new RateLimitedError('Ship24', 12_000) });
    expect(retryAfterMsOf(rateLimited)).toBe(12_000);
    expect(retryAfterMsOf(new NotFoundError('CTT'))).toBeUndefined();
    const ahead = new NoHistoryError('pengyou', undefined, { reason: 'written_ahead', writtenAhead: ['2026-03-02T10:00:00+08:00'] });
    expect(writtenAheadClocks(new Error('outer', { cause: ahead }))).toEqual(['2026-03-02T10:00:00+08:00']);
    expect(writtenAheadClocks(new NoHistoryError('pengyou'))).toEqual([]);
    expect(new NoHistoryError('pengyou', undefined, { writtenAhead: [] }).writtenAhead).toBeUndefined();
  });

  it('labels failures outside the taxonomy by what a retry could change', () => {
    expect(failureKind(new InvalidInputError('La Poste'))).toBe('invalid_input');
    expect(failureKind(new Error('outer', { cause: new NotFoundError('CTT') }))).toBe('not_found');
    // Thrown by the runtime while reading a reply: the payload was not the expected shape.
    for (const error of [new TypeError('Cannot read properties of undefined'), new RangeError('Invalid time value'), new SyntaxError('Unexpected token')]) {
      expect(failureKind(error)).toBe('schema');
    }
    expect(failureKind(new Error('socket closed'))).toBe('transport');
    expect(failureKind('string')).toBe('transport');
    expect(failureHint(new RateLimitedError('Ship24', 30_000))).toEqual({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(failureHint(new TypeError('bad payload'))).toEqual({ kind: 'schema' });
  });

  it('clamps negative retry windows and keeps custom statuses', () => {
    expect(new RateLimitedError('X', -5).retryAfterMs).toBe(0);
    expect(new CarrierError('transport', 'X', 'custom', { status: 599 }).status).toBe(599);
  });

  it('names errors for metric labels without leaking messages', () => {
    expect(errorTypeOf(new NotFoundError('CTT'))).toBe('NotFoundError');
    expect(errorTypeOf(Object.assign(new Error('x'), { name: 'weird name with spaces' }))).toBe('Error');
    expect(errorTypeOf(42)).toBe('number');
  });
});
