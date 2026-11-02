import { describe, expect, it } from 'vitest';
import { detectCarrierMatch } from '../detection/detect.js';
import { recognitionCandidates, recognitionNumberShape, recognizeAll, settleRecognition, type RecognitionOutcome } from './index.js';
import { recognitionAskedCarriers } from '../catalog/recognition.js';

const outcome = (carrier: string, status: RecognitionOutcome['status'], extra: Partial<RecognitionOutcome> = {}): RecognitionOutcome => ({
  carrier, status, needsInput: null, preferred: false, lastActivityAt: null, ...extra,
});
const now = new Date('2026-09-10T12:00:00Z');

describe('recognition candidates', () => {
  it.each(['200000000001', '200000000001034'])('asks J&T Cargo over HTTP for an ambiguous supported identifier: %s', number => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(recognitionCandidates(number)).toContainEqual({ carrier: 'j-and-t-cargo', needsInput: null, preferred: false });
    expect(recognitionAskedCarriers(number)).toContain('j-and-t-cargo');
    expect(recognitionCandidates(number, { phase: 'browser' }).map(({ carrier }) => carrier)).not.toContain('j-and-t-cargo');
  });

  it('orders eligible candidates by region without claiming ownership or changing detection', () => {
    const number = '60345678901231';
    const detected = detectCarrierMatch(number);
    const baseline = recognitionCandidates(number);
    const local = recognitionCandidates(number, { countryHint: ' gb ' });
    expect(local.slice(0, 2).map(({ carrier }) => carrier)).toEqual(['dpd-uk', 'dhl-ecommerce-uk']);
    expect(local.map(({ carrier }) => carrier).sort()).toEqual(baseline.map(({ carrier }) => carrier).sort());
    expect(detectCarrierMatch(number)).toEqual(detected);
    expect(recognitionAskedCarriers(number, { countryHint: 'GB' })).toContain('dhl-ecommerce-uk');
    expect(recognitionCandidates(number, { countryHint: 'United Kingdom' })).toEqual(baseline);
    expect(recognitionCandidates(number, { countryHint: 'XX' })).toEqual(baseline);
    expect(recognitionCandidates('1Z999AA10123456784', { countryHint: 'GB', priorities: { dpd: 1e6 } })).toEqual([]);
  });

  it('asks GLS Poland and GLS Austria about 11 digits only for a caller in their country', () => {
    // Synthetic: the GLS group's 11-digit layout names no network. The number also passes DHL
    // eCommerce Poland's check, which puts it first.
    const number = '12345678900';
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(number).candidates).toEqual(expect.arrayContaining(['gls-at', 'gls-pl']));
    expect(recognitionAskedCarriers(number)).toEqual(['dhl-ecommerce-pl', 'gls-fr', 'gls-de', 'gls-ch', 'postlogistics']);
    expect(recognitionAskedCarriers(number, { countryHint: 'PL' })).toContain('gls-pl');
    expect(recognitionAskedCarriers(number, { countryHint: 'AT' })[0]).toBe('gls-at');
    for (const country of [undefined, 'DE', 'CH', 'FR', 'CZ', 'GB']) {
      const asked = recognitionCandidates(number, { countryHint: country }).map(({ carrier }) => carrier);
      expect(asked, country).not.toContain('gls-pl');
      expect(asked, country).not.toContain('gls-at');
    }
  });

  it('asks GLS Poland and GLS Austria about the 12-digit form only for a caller in their country', () => {
    // Synthetic: the same parcel number printed with its GLS check digit. A Polish or Austrian
    // caller's network is asked first and tracks without the postcode GLS Germany requires.
    const number = '123456789011';
    for (const network of ['gls-at', 'gls-pl']) expect(detectCarrierMatch(number).candidates).toContain(network);
    expect(recognitionAskedCarriers(number, { countryHint: 'PL' })[0]).toBe('gls-pl');
    expect(recognitionAskedCarriers(number, { countryHint: 'AT' })[0]).toBe('gls-at');
    expect(settleRecognition([outcome('gls-pl', 'known', { countryMatch: 'home' }), outcome('gls-de', 'known', { needsInput: 'postcode' }),
      outcome('gls-ch', 'known', { needsInput: 'postcode' })], now)).toEqual({ carrier: 'gls-pl', choices: [] });
    const elsewhere = recognitionAskedCarriers(number);
    expect(elsewhere.slice(0, 3)).toEqual(['gls-fr', 'gls-de', 'gls-ch']);
    for (const country of ['DE', 'CH', 'FR', 'CZ', 'GB']) {
      const asked = recognitionCandidates(number, { countryHint: country }).map(({ carrier }) => carrier);
      expect(asked, country).not.toContain('gls-pl');
      expect(asked, country).not.toContain('gls-at');
    }
    // A twelfth digit that fails the GLS check is no GLS number.
    for (const network of ['gls-at', 'gls-pl']) expect(detectCarrierMatch('123456789012').candidates).not.toContain(network);
  });

  it('asks 4PX before Emile about Emile\'s sixteen-digit barcodes and settles on 4PX when both know one', () => {
    // Synthetic: Emile's barcode on a parcel 4PX hands over; 4PX's feed holds the whole journey.
    const number = 'EM0000000000000001CA';
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['four-px', 'emile'] });
    expect(recognitionCandidates(number, { countryHint: 'CA' })).toEqual([
      { carrier: 'four-px', needsInput: null, preferred: true },
      { carrier: 'emile', needsInput: null, preferred: false, countryMatch: 'home' },
    ]);
    for (const country of [undefined, 'CA', 'CN']) expect(recognitionAskedCarriers(number, { countryHint: country })).toEqual(['four-px', 'emile']);
    expect(settleRecognition([outcome('four-px', 'known', { preferred: true }), outcome('emile', 'known', { countryMatch: 'home' })], now))
      .toEqual({ carrier: 'four-px', choices: [] });
    expect(settleRecognition([outcome('four-px', 'unknown', { preferred: true }), outcome('emile', 'known')], now))
      .toEqual({ carrier: 'emile', choices: [] });
    // Twelve digits stay Emile's alone, and Canada Post's EMS items keep nine.
    expect(recognitionAskedCarriers('EM000000000001CA')).toEqual(['emile']);
    expect(detectCarrierMatch('EM123456785CA')).toMatchObject({ carrier: 'canada-post', confidence: 'high' });
    for (const near of ['EM000000000000001CA', 'EM00000000000000001CA', 'EM0000000000000001US', 'EE0000000000000001CA']) {
      expect(detectCarrierMatch(near).candidates, near).not.toContain('four-px');
      expect(detectCarrierMatch(near).candidates, near).not.toContain('emile');
    }
  });

  it('leaves a ten-digit number DHL Express and ACS both know to the user, since the check digit backs neither', () => {
    // Synthetic: ACS's vouchers carry DHL Express's check digit, the first nine digits modulo 7.
    const number = '2718281823';
    const candidates = recognitionCandidates(number, { countryHint: 'GR' });
    expect(candidates.find(({ carrier }) => carrier === 'dhl-express')?.checkDigitPeers)
      .toEqual(expect.arrayContaining(['acs-courier', 'geniki-taxydromiki']));
    expect(candidates.find(({ carrier }) => carrier === 'dhl-express')?.checkDigitPeers).not.toContain('box-now');
    expect(candidates.find(({ carrier }) => carrier === 'acs-courier')).not.toHaveProperty('checkDigitPeers');
    expect(recognitionAskedCarriers(number, { countryHint: 'GR' })).toEqual(expect.arrayContaining(['dhl-express', 'acs-courier']));
    const dhlExpress = outcome('dhl-express', 'known', { preferred: true, checkDigitPeers: ['acs-courier', 'geniki-taxydromiki'] });
    const acs = outcome('acs-courier', 'known', { countryMatch: 'home' });
    expect(settleRecognition([dhlExpress, acs], now)).toEqual({ choices: ['dhl-express', 'acs-courier'] });
    expect(settleRecognition([dhlExpress, { ...acs, status: 'unknown' }], now)).toEqual({ carrier: 'dhl-express', choices: [] });
    expect(settleRecognition([{ ...dhlExpress, status: 'unknown' }, acs], now)).toEqual({ carrier: 'acs-courier', choices: [] });
    // Against a carrier whose number passes no check of its own, the check digit still settles.
    expect(settleRecognition([dhlExpress, outcome('box-now', 'known', { countryMatch: 'home' })], now))
      .toEqual({ carrier: 'dhl-express', choices: [] });
    // A number that fails the check is not offered to ACS.
    expect(recognitionCandidates('2718281824', { countryHint: 'GR' }).map(({ carrier }) => carrier)).not.toContain('acs-courier');
  });

  it('keeps direct hints and number evidence ahead of weak ordering hints', () => {
    expect(recognitionCandidates('06080000000002', { countryHint: 'GB', priorities: { 'dpd-uk': 1e6 } })[0]?.carrier).toBe('dpd');
    expect(recognitionCandidates('06080000000002', { hint: 'seur', countryHint: 'GB' })[0]?.carrier).toBe('seur');
    const shadowed = recognitionCandidates('10000000000001', { countryHint: 'CH', priorities: { dpd: 1e6 } });
    expect(shadowed.map(({ carrier }) => carrier)).not.toContain('dpd');
  });

  it('uses finite aggregate priorities within the eligible catalog and preserves phase boundaries', () => {
    const number = '12345678901231';
    expect(recognitionCandidates(number, { priorities: { ciblex: 20, seur: 10, ups: 1e6 } }).map(({ carrier }) => carrier).slice(0, 2)).toEqual(['ciblex', 'seur']);
    expect(recognitionCandidates(number, { priorities: { ciblex: NaN, seur: Infinity, brt: -10 } })).toEqual(recognitionCandidates(number));
    expect(recognitionCandidates(number, { countryHint: 'GB', priorities: { ciblex: 1e6 } })[0]?.carrier).toBe('dpd-uk');
    expect(recognitionCandidates('000000000011', { countryHint: 'US', priorities: { fedex: 1e6 } }).map(({ carrier }) => carrier)).not.toContain('fedex');
    expect(recognitionCandidates('000000000011', { phase: 'browser', countryHint: 'US', priorities: { fedex: 1 } }).map(({ carrier }) => carrier)).toEqual(['fedex']);
  });

  it('retains only character classes and run lengths in aggregate shapes', () => {
    expect(recognitionNumberShape('ab 123.456-789 xy')).toBe('A2D9A2');
    expect(recognitionNumberShape('00000000000001')).toBe('D14');
    expect(recognitionNumberShape('ABCDEF')).toBe('A6');
    expect(recognitionNumberShape('ABC')).toBeUndefined();
    expect(recognitionNumberShape('1234?')).toBeUndefined();
    expect(recognitionNumberShape('1'.repeat(41))).toBeUndefined();
  });

  it('keeps the carriers that can answer, hint first, then number evidence, then popularity', () => {
    // Hermes's check digit passes, which puts Hermes ahead of popularity alone.
    expect(recognitionCandidates('12345678901231').map((candidate) => candidate.carrier)).toEqual(['hermes-de', 'dpd-be', 'dpd', 'dpd-nl', 'dpd-de', 'chronopost', 'seur', 'brt', 'dpd-uk', 'dpd-pt', 'dpd-hu', 'ciblex', 'delhivery']);
    expect(recognitionCandidates('06080000000002')).toEqual([
      { carrier: 'dpd', needsInput: null, preferred: true },
      { carrier: 'dpd-be', needsInput: null, preferred: false },
      { carrier: 'dpd-nl', needsInput: null, preferred: false },
      { carrier: 'dpd-de', needsInput: null, preferred: false },
      { carrier: 'chronopost', needsInput: null, preferred: false },
      { carrier: 'seur', needsInput: null, preferred: false },
      { carrier: 'brt', needsInput: null, preferred: false },
      { carrier: 'dpd-uk', needsInput: null, preferred: false },
      { carrier: 'dpd-pt', needsInput: null, preferred: false },
      { carrier: 'dpd-hu', needsInput: null, preferred: false },
      { carrier: 'ciblex', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('12345678901', { hint: 'gls-de' })).toEqual([
      { carrier: 'gls-de', needsInput: 'postcode', preferred: false },
      { carrier: 'gls-fr', needsInput: null, preferred: false },
      { carrier: 'gls-ch', needsInput: 'postcode', preferred: false },
      { carrier: 'postlogistics', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('06080000000002', { skip: (carrier) => carrier === 'dpd' }).map((candidate) => candidate.carrier))
      .toEqual(['dpd-be', 'dpd-nl', 'dpd-de', 'chronopost', 'seur', 'brt', 'dpd-uk', 'dpd-pt', 'dpd-hu', 'ciblex']);
    // A selected carrier needs no recognition.
    expect(recognitionCandidates('1Z999AA10123456784')).toEqual([]);
    // A DPD France depot: DPD France cannot be asked, and DPD Switzerland's or
    // DPD Germany's group-wide answer would file its parcel under the wrong network.
    expect(recognitionCandidates('10000000000001').map((candidate) => candidate.carrier)).toEqual(['seur', 'brt', 'anteraja', 'ciblex', 'delhivery']);
  });

  it('asks GLS France, then GLS Germany, then GLS Switzerland about a GLS number', () => {
    // GLS's group overview answers for every network's parcels alike, so GLS
    // Germany and GLS Switzerland always agree; GLS France answers only its own.
    for (const number of ['12345678901', '123456789011', 'AB12CD34']) {
      expect(recognitionAskedCarriers(number).slice(0, 3)).toEqual(['gls-fr', 'gls-de', 'gls-ch']);
    }
    expect(recognitionAskedCarriers('ABCDEF')).toEqual(['gls-de', 'gls-ch']);
    // A caller's country puts its network first, and marks it for settling.
    expect(recognitionAskedCarriers('12345678901', { countryHint: 'CH' })[0]).toBe('gls-ch');
    const marks = (countryHint?: string) => Object.fromEntries(recognitionCandidates('12345678901', { countryHint })
      .filter(({ carrier }) => carrier.startsWith('gls-')).map(({ carrier, countryMatch }) => [carrier, countryMatch]));
    expect(marks('ch')).toEqual({ 'gls-ch': 'home', 'gls-de': undefined, 'gls-fr': undefined });
    expect(marks('LI')).toEqual({ 'gls-ch': 'served', 'gls-de': undefined, 'gls-fr': undefined });
    expect(marks('PL')).toEqual({ 'gls-pl': 'home', 'gls-at': undefined, 'gls-ch': undefined, 'gls-de': undefined, 'gls-fr': undefined });
    expect(marks('AT')).toEqual({ 'gls-at': 'home', 'gls-pl': undefined, 'gls-ch': undefined, 'gls-de': undefined, 'gls-fr': undefined });
    expect(marks()).toEqual({ 'gls-ch': undefined, 'gls-de': undefined, 'gls-fr': undefined });
    expect(marks('XX')).toEqual(marks());
  });

  it('only suggests a carrier for a number its recognition cannot answer', () => {
    // Saia's check digit passes, but Saia's reply binds only the eleven digits before it.
    const number = '900000000005';
    expect(detectCarrierMatch(number).candidates).toContain('saia');
    for (const options of [{}, { hint: 'saia' }, { countryHint: 'US', priorities: { saia: 1e6 } }]) {
      expect(recognitionCandidates(number, options).map(({ carrier }) => carrier)).not.toContain('saia');
    }
    // TIPSA's lookup needs its full 22-digit reference; ten digits stay a suggestion.
    expect(detectCarrierMatch('1234567890').candidates).toContain('tipsa');
    expect(recognitionCandidates('1234567890', { hint: 'tipsa' }).map(({ carrier }) => carrier)).not.toContain('tipsa');
    expect(recognitionCandidates('0123450123451234567890').map(({ carrier }) => carrier)).toContain('tipsa');
    // bpost documents its numeric barcodes with their 3232 and 3299 prefixes; other digits stay a suggestion.
    for (const number of ['000000000000000001', '000000000000000000000001']) {
      expect(detectCarrierMatch(number).candidates, number).toContain('bpost');
      expect(recognitionCandidates(number, { hint: 'bpost', countryHint: 'BE' }).map(({ carrier }) => carrier), number).not.toContain('bpost');
    }
  });

  it('asks Speedy first for its 63 series and in Bulgaria for the rest of its 6 series', () => {
    // No other carrier's public eleven digits start 63, so Speedy leads wherever the lookup comes from.
    expect(detectCarrierMatch('63000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['speedy'] });
    for (const countryHint of [undefined, 'BG', 'DE', 'CZ', 'GB']) {
      expect(recognitionCandidates('63000000001', { countryHint })[0]?.carrier, countryHint).toBe('speedy');
    }
    // GLS, PPL and Japan Post numbers appear elsewhere in the 6 series, where Speedy is only a suggestion.
    expect(detectCarrierMatch('60600000001')).toMatchObject({ confidence: 'low', preferred: [] });
    expect(recognitionCandidates('60600000001', { countryHint: 'BG' })[0]?.carrier).toBe('speedy');
    expect(recognitionCandidates('68200000001', { countryHint: 'DE' })[0]?.carrier).toBe('gls-de');
    expect(recognitionCandidates('60100000001', { countryHint: 'CZ' })[0]?.carrier).toBe('ppl');
    // Palletways' consignment IDs run in the 600 series, and Speedy's other first digits stay unclaimed.
    for (const number of ['60000000001', '51900000001', '73000000001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('speedy');
    }
  });

  it('can ask bpost about an ambiguous numeric barcode without a recipient postcode', () => {
    expect(recognitionCandidates('323200000000000000000001')).toEqual(expect.arrayContaining([
      { carrier: 'bpost', needsInput: null, preferred: true },
    ]));
  });

  it('confirms direct postal candidates before the unknown-postal fallback', () => {
    // Finnish issuance is number evidence for a lookup, not proof of delivery.
    expect(detectCarrierMatch('CE123456785FI')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('ce 123.456-785 fi')).toEqual([
      { carrier: 'posti', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('RA123456785IR')).toEqual([
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('CE123456785FI', { hint: 'chronopost' }).map(({ carrier }) => carrier))
      .toEqual(['chronopost', 'posti']);
    expect(recognitionCandidates('CE123456785FI', { skip: (carrier) => carrier === 'posti' }).map(({ carrier }) => carrier))
      .toEqual(['chronopost']);
  });

  it('does not infer Posti from a failed postal checksum or probe a known direct postal carrier', () => {
    expect(recognitionCandidates('CE123456789FI').map(({ carrier }) => carrier)).not.toContain('posti');
    // A failed check digit under another post's suffix is a mistyped number:
    // Chronopost's own codes without one keep its prefixes or suffixes.
    expect(recognitionCandidates('CE123456789FI')).toEqual([]);
    expect(recognitionCandidates('RA123456785CH')).toEqual([]);
  });
});

describe('asking carriers', () => {
  it('keeps browser checks separate from HTTP checks', () => {
    expect(recognitionCandidates('000000000011').map(({ carrier }) => carrier)).not.toContain('fedex');
    expect(recognitionCandidates('000000000011', { phase: 'browser' }).map(({ carrier }) => carrier)).toEqual(['fedex']);
    expect(recognitionCandidates('33870000000000001', { phase: 'browser' }).map(({ carrier }) => carrier)).toEqual(['dhl-ecommerce']);
  });
  it('aborts callbacks at the deadline and on caller cancellation', async () => {
    let seen: AbortSignal | undefined;
    const candidates = recognitionCandidates('000000000011', { phase: 'browser' });
    const outcomes = await recognizeAll(candidates, async (_carrier, context) => {
      seen = context.signal;
      return new Promise(() => undefined);
    }, 10);
    expect(seen?.aborted).toBe(true);
    expect(outcomes[0]?.status).toBe('failed');
    const controller = new AbortController();
    const request = recognizeAll(candidates, async (_carrier, context) => {
      seen = context.signal;
      return new Promise(() => undefined);
    }, 10_000, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
  });
  it('asks all at once and treats a failure or a late answer as no answer', async () => {
    const started: string[] = [];
    const outcomes = await recognizeAll(recognitionCandidates('12345678901231'), async (carrier) => {
      started.push(carrier);
      if (carrier === 'dpd') return { known: true, lastActivityAt: '2026-09-09T08:00:00Z' };
      if (carrier === 'hermes-de') throw new Error('upstream down');
      if (carrier === 'seur' || carrier === 'brt') return { known: false };
      return new Promise(() => undefined);
    }, 20);
    expect(started).toEqual(['hermes-de', 'dpd-be', 'dpd', 'dpd-nl', 'dpd-de', 'chronopost', 'seur', 'brt', 'dpd-uk', 'dpd-pt', 'dpd-hu', 'ciblex', 'delhivery']);
    expect(outcomes.map(({ carrier, status }) => [carrier, status])).toEqual([
      ['hermes-de', 'failed'], ['dpd-be', 'failed'], ['dpd', 'known'], ['dpd-nl', 'failed'], ['dpd-de', 'failed'], ['chronopost', 'failed'], ['seur', 'unknown'], ['brt', 'unknown'], ['dpd-uk', 'failed'], ['dpd-pt', 'failed'], ['dpd-hu', 'failed'], ['ciblex', 'failed'], ['delhivery', 'failed'],
    ]);
    expect(outcomes[2]!.lastActivityAt).toBe('2026-09-09T08:00:00Z');
  });
});

describe('settling on a carrier', () => {
  it('picks the only recent answer', () => {
    expect(settleRecognition([outcome('dpd', 'known'), outcome('ciblex', 'unknown'), outcome('hermes-de', 'failed')], now))
      .toEqual({ carrier: 'dpd', choices: [] });
    expect(settleRecognition([outcome('dpd', 'known', { lastActivityAt: '2026-01-02T00:00:00Z' }), outcome('ciblex', 'known')], now))
      .toEqual({ carrier: 'ciblex', choices: [] });
    expect(settleRecognition([outcome('dpd', 'unknown')], now)).toEqual({ choices: [] });
  });
  it('takes an answer without a clock for one of unknown age, never for a recent one', () => {
    const recentScan = { lastActivityAt: '2026-09-09T08:00:00Z' };
    // A reused number: Happy-Post still knows its old label, dated on its local clock only.
    const oldLabel = { lastActivityLocal: '2026-03-02T09:00:00' };
    expect(settleRecognition([outcome('happy-post', 'known', oldLabel)], now)).toEqual({ choices: [] });
    expect(settleRecognition([outcome('happy-post', 'known', oldLabel), outcome('dpd-uk', 'known', recentScan)], now))
      .toEqual({ carrier: 'dpd-uk', choices: [] });
    // A label without any clock does not compete with a recent scan, and settles when it is the only answer.
    expect(settleRecognition([outcome('happy-post', 'known'), outcome('dpd-uk', 'known', recentScan)], now))
      .toEqual({ carrier: 'dpd-uk', choices: [] });
    expect(settleRecognition([outcome('happy-post', 'known'), outcome('dpd-uk', 'known', { lastActivityAt: '2026-01-02T00:00:00Z' })], now))
      .toEqual({ carrier: 'happy-post', choices: [] });
    // A local clock is recent while any zone can still read it inside the window, which ends on 12 July at noon UTC.
    expect(settleRecognition([outcome('happy-post', 'known', { lastActivityLocal: '2026-07-12T06:00:00' })], now))
      .toEqual({ carrier: 'happy-post', choices: [] });
    expect(settleRecognition([outcome('happy-post', 'known', { lastActivityAt: '2026-07-12T06:00:00Z' })], now)).toEqual({ choices: [] });
    expect(settleRecognition([outcome('happy-post', 'known', { lastActivityLocal: '2026-09-08T09:00:00' }), outcome('dpd-uk', 'known', recentScan)], now))
      .toEqual({ choices: ['happy-post', 'dpd-uk'] });
  });

  it('carries a local clock from the answer to the outcome', async () => {
    const [answer] = await recognizeAll([{ carrier: 'happy-post', needsInput: null, preferred: false }],
      async () => ({ known: true, lastActivityAt: null, lastActivityLocal: '2026-03-02T09:00:00' }), 1_000);
    expect(answer).toMatchObject({ status: 'known', lastActivityAt: null, lastActivityLocal: '2026-03-02T09:00:00' });
    expect(settleRecognition([answer!], now)).toEqual({ choices: [] });
  });

  it('prefers number evidence, then one brand\'s most common network, and otherwise lets the user choose', () => {
    expect(settleRecognition([outcome('dpd', 'known', { preferred: true }), outcome('ciblex', 'known')], now))
      .toEqual({ carrier: 'dpd', choices: [] });
    expect(settleRecognition([outcome('gls-ch', 'known'), outcome('gls-de', 'known')], now))
      .toEqual({ carrier: 'gls-de', choices: [] });
    // GLS France's own tracker answers only French parcels, with the history and no postcode.
    expect(settleRecognition([outcome('gls-ch', 'known'), outcome('gls-de', 'known'), outcome('gls-fr', 'known')], now))
      .toEqual({ carrier: 'gls-fr', choices: [] });
    // GLS's group service answers every network's parcels: the caller's country names the network.
    expect(settleRecognition([outcome('gls-pl', 'known', { countryMatch: 'home' }), outcome('gls-de', 'known'), outcome('gls-ch', 'known')], now))
      .toEqual({ carrier: 'gls-pl', choices: [] });
    expect(settleRecognition([outcome('gls-at', 'known'), outcome('gls-de', 'known')], now))
      .toEqual({ carrier: 'gls-de', choices: [] });
    expect(settleRecognition([outcome('dpd', 'known'), outcome('hermes-de', 'known')], now))
      .toEqual({ choices: ['dpd', 'hermes-de'] });
    expect(settleRecognition([outcome('seur', 'known'), outcome('brt', 'known')], now))
      .toEqual({ choices: ['seur', 'brt'] });
  });

  it('files a number under the carrier that follows it for its delivery carrier', () => {
    // AliExpress shows the buyer the delivery carrier's number; both know it once the parcel has crossed the border.
    expect(settleRecognition([outcome('poste-italiane', 'known'), outcome('aliexpress', 'known')], now))
      .toEqual({ carrier: 'aliexpress', choices: [] });
    expect(settleRecognition([outcome('poste-italiane', 'known', { preferred: true }), outcome('aliexpress', 'known')], now))
      .toEqual({ carrier: 'aliexpress', choices: [] });
    expect(settleRecognition([outcome('poste-italiane', 'known'), outcome('aliexpress', 'unknown')], now))
      .toEqual({ carrier: 'poste-italiane', choices: [] });
    // An old AliExpress parcel that used the number says nothing about this one.
    expect(settleRecognition([outcome('poste-italiane', 'known', { lastActivityAt: '2026-09-09T00:00:00Z' }),
      outcome('aliexpress', 'known', { lastActivityAt: '2026-01-02T00:00:00Z' })], now))
      .toEqual({ carrier: 'poste-italiane', choices: [] });
  });

  it('settles one brand\'s networks on the one serving the caller\'s country, after any that needs no input', () => {
    const postcode = { needsInput: 'postcode' } as const;
    expect(settleRecognition([outcome('gls-ch', 'known', { ...postcode, countryMatch: 'home' }), outcome('gls-de', 'known', postcode)], now))
      .toEqual({ carrier: 'gls-ch', choices: [] });
    expect(settleRecognition([outcome('gls-ch', 'known', { ...postcode, countryMatch: 'served' }), outcome('gls-de', 'known', postcode)], now))
      .toEqual({ carrier: 'gls-ch', choices: [] });
    expect(settleRecognition([outcome('gls-ch', 'known', postcode), outcome('gls-de', 'known', { ...postcode, countryMatch: 'home' })], now))
      .toEqual({ carrier: 'gls-de', choices: [] });
    expect(settleRecognition([outcome('dpd', 'known'), outcome('dpd-de', 'known', { countryMatch: 'home' })], now))
      .toEqual({ carrier: 'dpd-de', choices: [] });
    // GLS France knowing the number makes it a French parcel, tracked without a postcode.
    expect(settleRecognition([
      outcome('gls-ch', 'known', { ...postcode, countryMatch: 'home' }), outcome('gls-de', 'known', postcode), outcome('gls-fr', 'known'),
    ], now)).toEqual({ carrier: 'gls-fr', choices: [] });
    // Number evidence still comes first, and unrelated carriers stay a choice.
    expect(settleRecognition([outcome('dpd', 'known', { countryMatch: 'home' }), outcome('dpd-de', 'known', { preferred: true })], now))
      .toEqual({ carrier: 'dpd-de', choices: [] });
    expect(settleRecognition([outcome('dpd', 'known', { countryMatch: 'home' }), outcome('hermes-de', 'known')], now))
      .toEqual({ choices: ['dpd', 'hermes-de'] });
  });

  it('carries the caller\'s country from the candidates to the settled network', async () => {
    const settled = async (countryHint?: string) => settleRecognition(await recognizeAll(
      recognitionCandidates('12345678901', { countryHint }),
      async (carrier) => ({ known: carrier === 'gls-ch' || carrier === 'gls-de' }),
      1_000,
    ), now).carrier;
    expect(await settled('CH')).toBe('gls-ch');
    expect(await settled('LI')).toBe('gls-ch');
    expect(await settled('DE')).toBe('gls-de');
    expect(await settled()).toBe('gls-de');
    expect(await settled('FR')).toBe('gls-de');
  });
});
