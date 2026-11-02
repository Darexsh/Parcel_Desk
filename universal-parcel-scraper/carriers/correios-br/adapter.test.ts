import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { carrierErrorKind, InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import type { TrawlCapturedResponse, TrawlClient } from '../../core/transport/trawl.js';
import { CorreiosTracker } from './adapter.js';
import { isCorreiosCaptchaError, normalizeCorreiosNumber, parseCorreios } from './parser.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { classifyCorreiosStatus } from './status.js';

const NUMBER = 'AA000000005BR';
const HOME = 'https://rastreamento.correios.com.br/app/index.php';
const IMAGE = 'https://rastreamento.correios.com.br/core/securimage/securimage_show.php';
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
const clone = () => structuredClone(fixture);
const scan = (code: string, kind: string, description: string, clock: unknown) => ({ codigo: code, tipo: kind, descricao: description, dtHrCriado: clock });

function portal(payload: unknown = fixture) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (raw: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(raw));
    calls.push({ url, init });
    if (url.href === HOME) {
      const response = new Response('<html>Tracking portal</html>', { headers: { 'Set-Cookie': 'PHPSESSID=synthetic-session; Path=/; Secure; HttpOnly' } });
      Object.defineProperty(response, 'url', { value: HOME });
      return response;
    }
    if (url.href === IMAGE) return image();
    return json(payload);
  }) as unknown as typeof fetch;
  const solveCaptcha = vi.fn(async () => 'a1b2');
  return { tracker: new CorreiosTracker({ fetcher, solveCaptcha }), calls, fetcher, solveCaptcha };
}

describe('Correios parser', () => {
  it('projects explicit zoned history and composite scan meanings without private fields', () => {
    const result = normalizeCarrierResult(parseCorreios(fixture, NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-05T16:10:47-03:00', delivered_at: '2026-01-05T16:10:47-03:00', expected_delivery: null });
    expect(result.events).toHaveLength(7);
    expect(result.events?.[0]).toEqual({ description: 'Objeto entregue ao destinatário', provider_code: 'BDE/01', time: '2026-01-05T16:10:47-03:00', location: 'Cidade Exemplo, SP', stage: 'delivered' });
    expect(result.events?.[2]!.stage).toBe('exception');
    expect(result.events?.[3]!.stage).toBe('exception');
    expect(result.events?.[5]!.stage).toBe('accepted');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC');
    for (const row of statuses.entries) expect(classifyCorreiosStatus(row.code)?.stage).toBe(row.stage);
    expect(classifyCorreiosStatus('BDE/99')).toBeUndefined();
  });

  it('reads a universal provider\'s copy by the wording Correios gives a recorded code', () => {
    const answer = (providerCode: string | null, description: string) => statusMapAnswer({ carrier: 'correios-br', providerCode, description });
    expect(answer('InfoReceived', 'Objeto postado')).toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(answer(null, 'Objeto recebido na unidade de exportação no país de origem')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer(null, 'Objeto entregue ao destinatário')).toEqual({ kind: 'mapped', stage: 'delivered' });
    // Correios's own code decides, even an unrecorded one.
    expect(answer('BDE/99', 'Objeto postado')).toEqual({ kind: 'unknown' });
    expect(answer(null, 'Synthetic wording')).toEqual({ kind: 'unknown' });
  });

  it('requires one exact response identity and structurally complete bounded scans', () => {
    expect(normalizeCorreiosNumber('aa 000000005 br')).toBe(NUMBER);
    for (const raw of ['AA000000000BR', '123', '', 'AA000000005BR?']) expect(() => normalizeCorreiosNumber(raw)).toThrow(InvalidInputError);
    for (const payload of [null, [], {}, { ...fixture, codObjeto: 'BB000000005BR' }, { ...fixture, eventos: null }, { ...fixture, eventos: [null] },
      { ...fixture, eventos: [scan('BDE', '', 'Incomplete', null)] }, { ...fixture, eventos: [scan('BDE', '01', '', null)] },
      { ...fixture, eventos: Array(501).fill(fixture.eventos[0]) }]) expect(() => parseCorreios(payload, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreios({ ...fixture, eventos: [] }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps newest unknown, malformed and missing clocks before older delivery scans', () => {
    for (const clock of [null, { date: 'Not supplied' }, { date: '2026-02-30 15:00:00.000000', timezone_type: 3, timezone: 'America/Sao_Paulo' }]) {
      const result = parseCorreios({ ...fixture, eventos: [scan('BDE', '99', 'New unmapped scan', clock), ...fixture.eventos] }, NUMBER);
      expect(result).toMatchObject({ status: 'unknown', last_status_text: 'New unmapped scan', last_update: null });
      expect(result.current_stage).toBeUndefined();
      expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]!.provider_code).toBe('BDE/99');
      expect(result.events?.[0]!.time).toBeUndefined();
      if (clock?.date) expect(result.events?.[0]!.provider_time_text).toBe(clock.date);
    }
  });

  it('trusts per-row zones but keeps missing, invalid, repeated and nonexistent clocks local', () => {
    const clock = { date: '2026-01-05 16:10:47.000000', timezone_type: 3, timezone: 'America/Manaus' };
    expect(parseCorreios({ ...fixture, eventos: [scan('BDE', '01', 'Delivery', clock)] }, NUMBER).last_update).toBe('2026-01-05T16:10:47-04:00');
    for (const raw of [clock.date, { date: clock.date }, { ...clock, timezone_type: 1 }, { ...clock, timezone: 'Invalid/Zone' },
      { date: '2026-11-01 01:30:00.000000', timezone_type: 3, timezone: 'America/New_York' },
      { date: '2026-03-08 02:30:00.000000', timezone_type: 3, timezone: 'America/New_York' }]) {
      const result = parseCorreios({ ...fixture, eventos: [scan('BDE', '01', 'Delivery', raw)] }, NUMBER);
      expect(result.last_update).toBeNull();
      expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]!.local_time).toMatch(/^2026-/);
      expect(result.events?.[0]!.time).toBeUndefined();
    }
  });

  it('reads returns to the sender, collection points, labels and the other delivery units', () => {
    const clock = { date: '2026-01-07 10:00:00.000000', timezone_type: 3, timezone: 'America/Sao_Paulo' };
    for (const [code, kind, description, status, stage] of [
      ['BDE', '23', 'Objeto entregue ao remetente', 'exception', 'returned'],
      ['OEC', '09', 'Objeto saiu para entrega ao remetente', 'exception', 'returned'],
      ['PAR', '24', 'Devolução determinada pela autoridade competente', 'exception', 'returned'],
      ['BDE', '20', 'Objeto não entregue - carteiro não atendido', 'exception', 'failed_attempt'],
      ['LDI', '02', 'Objeto aguardando retirada na Caixa Postal', 'in_transit', 'ready_for_pickup'],
      ['BDI', '01', 'Objeto entregue ao destinatário', 'delivered', 'delivered'],
      ['BDI', '40', 'Importação não autorizada', 'exception', 'exception'],
      ['FC', '82', 'Etiqueta emitida', 'pending', 'registered'],
      ['FC', '03', 'Objeto em correção de rota', 'in_transit', 'in_transit'],
      ['PAR', '16', 'Objeto recebido pelos Correios do Brasil', 'in_transit', 'in_transit'],
      ['FC', '16', 'Necessidade de informar CPF/CNPJ do destinatário', 'in_transit', 'customs'],
    ] as const) {
      const result = parseCorreios({ ...fixture, eventos: [scan(code, kind, description, clock), ...fixture.eventos] }, NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
  });

  it("reads the sending post's posting listed again at its dispatch as transit", () => {
    const at = (time: string) => ({ date: `2026-01-0${time}.000000`, timezone_type: 3, timezone: 'America/Santiago' });
    const result = parseCorreios({ ...fixture, eventos: [
      scan('PAR', '18', 'Objeto recebido na unidade de exportação no país de origem', at('4 08:00:00')),
      scan('PO', '01', 'Objeto postado', at('2 21:12:00')),
      scan('PO', '01', 'Objeto postado', at('2 10:43:00')),
    ] }, NUMBER);
    expect(result.events!.map(({ provider_code: code, stage }) => [code, stage])).toEqual([
      ['PAR/18', 'in_transit'], ['PO/01', 'in_transit'], ['PO/01', 'accepted']]);
    const once = parseCorreios({ ...fixture, eventos: [scan('PO', '01', 'Objeto postado', at('2 10:43:00'))] }, NUMBER);
    expect(once).toMatchObject({ current_stage: 'accepted', events: [{ stage: 'accepted' }] });
  });

  it('reads the service and shows the delivery forecast only where the portal does', () => {
    const transit = { ...clone(), situacao: 'T', dtPrevista: '08/01/2026', tipoPostal: { sigla: 'AA', descricao: 'ETIQUETA EXEMPLO', categoria: 'SEDEX', tipo: 'N' } };
    transit.eventos = transit.eventos.slice(4);
    expect(parseCorreios(transit, NUMBER)).toMatchObject({ status: 'in_transit', expected_delivery: '2026-01-08', service_name: 'SEDEX' });
    for (const change of [{ atrasado: true }, { situacao: 'E' }, { dtPrevista: '' }, { dtPrevista: '31/02/2026' }, { dtPrevista: '2026-01-08' }]) {
      expect(parseCorreios({ ...transit, ...change }, NUMBER).expected_delivery).toBeNull();
    }
    const waiting = { ...transit, eventos: [scan('LDI', '02', 'Objeto aguardando retirada na Caixa Postal', null), ...transit.eventos] };
    expect(parseCorreios(waiting, NUMBER).expected_delivery).toBeNull();
    expect(parseCorreios(fixture, NUMBER)).not.toHaveProperty('service_name');
  });

  it('deduplicates projected scans and bounds text without promoting delivery-related failures', () => {
    const duplicate = clone();
    duplicate.eventos.push(structuredClone(duplicate.eventos[0]!));
    expect(parseCorreios(duplicate, NUMBER).events).toHaveLength(7);
    for (const kind of ['34', '47']) {
      const result = parseCorreios({ ...fixture, eventos: [scan('BDE', kind, 'x'.repeat(600), 'x'.repeat(100)), ...fixture.eventos] }, NUMBER);
      expect(result.status).toBe('exception');
      expect(result.delivered_at).toBeUndefined();
      expect(result.events?.[0]!.description).toHaveLength(500);
      expect(result.events?.[0]!.provider_time_text).toHaveLength(64);
    }
  });

  it('never assigns an older delivery instant to a newer delivery with an unresolved clock', () => {
    const newest = scan('BDE', '01', 'Objeto entregue ao destinatário', { date: '2026-01-06 16:10:00.000000', timezone_type: 3, timezone: 'Invalid/Zone' });
    const result = parseCorreios({ ...fixture, eventos: [newest, ...fixture.eventos] }, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-01-06T16:10:00' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('distinguishes explicit CAPTCHA rejection from unbound and period errors', () => {
    for (const erro of [true, 'true']) {
      const rejected = { erro, mensagem: 'Captcha inválido' };
      expect(isCorreiosCaptchaError(rejected)).toBe(true);
      expect(() => parseCorreios(rejected, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
      for (const mensagem of ['Período inválido', 'Objeto não encontrado', 'Serviço indisponível']) {
        expect(() => parseCorreios({ erro, mensagem }, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
      }
    }
    expect(isCorreiosCaptchaError({ mensagem: 'Captcha inválido' })).toBe(false);
    expect(isCorreiosCaptchaError({ erro: true, mensagem: 'captcha service unavailable' })).toBe(false);
  });
});

describe('Correios session and transport', () => {
  it('bootstraps cookies, submits one bounded query and keeps separate lookup sessions', async () => {
    const { tracker, calls, solveCaptcha } = portal();
    await tracker.fetch(NUMBER);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url.href).toBe(HOME);
    expect(calls[1]!.url.href).toBe(IMAGE);
    expect(calls[2]!.url.pathname).toBe('/app/resultado.php');
    expect(Object.fromEntries(calls[2]!.url.searchParams)).toEqual({ objeto: NUMBER, captcha: 'a1b2', mqs: 'S' });
    expect(solveCaptcha).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), expect.any(AbortSignal));
    expect(new Headers(calls[1]!.init?.headers).get('cookie')).toBe('PHPSESSID=synthetic-session');
    expect(new Headers(calls[2]!.init?.headers).get('referer')).toBe(HOME);
    // fetch-cookie uses manual fetches and honors the original redirect:error policy.
    expect(calls.every((call) => call.init?.cache === 'no-store' && call.init?.redirect === 'manual' && call.init?.signal instanceof AbortSignal)).toBe(true);
    await tracker.fetch(NUMBER);
    expect(new Headers(calls[3]!.init?.headers).get('cookie')).toBeNull();
    expect(calls).toHaveLength(6);
  });

  it('retries only one fresh image after an explicit rejection, not arbitrary errors or schema mismatch', async () => {
    const { tracker, fetcher, calls } = portal();
    vi.mocked(fetcher).mockImplementationOnce(async () => new Response('portal'))
      .mockImplementationOnce(async () => image())
      .mockImplementationOnce(async () => json({ erro: 'true', mensagem: 'Captcha inválido' }));
    expect((await tracker.fetch(NUMBER)).status).toBe('delivered');
    expect(calls.map((call) => call.url.pathname)).toEqual(['/core/securimage/securimage_show.php', '/app/resultado.php']);
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const payload of [{ erro: true, mensagem: 'Período inválido' }, { ...fixture, codObjeto: 'BB000000005BR' }]) {
      const probe = portal(payload);
      await expect(probe.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: payload.erro ? 'indeterminate' : 'schema' });
      expect(probe.calls).toHaveLength(3);
    }
    const exhausted = portal({ erro: true, mensagem: 'Captcha inválido' });
    await expect(exhausted.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(exhausted.calls).toHaveLength(5);
  });

  it('bounds unreadable OCR retries, image bytes, content type and invalid JSON', async () => {
    const unreadable = portal();
    unreadable.solveCaptcha.mockResolvedValue('ABC?');
    await expect(unreadable.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(unreadable.calls).toHaveLength(3);
    expect(unreadable.calls.some((call) => call.url.pathname === '/app/resultado.php')).toBe(false);
    for (const reply of [new Response('html', { headers: { 'Content-Type': 'text/html' } }),
      new Response(new Uint8Array(100_001), { headers: { 'Content-Type': 'image/png' } })]) {
      const p = portal();
      vi.mocked(p.fetcher).mockImplementationOnce(async () => new Response('portal')).mockImplementationOnce(async () => reply);
      await expect(p.tracker.fetch(NUMBER)).rejects.toBeInstanceOf(Error);
      expect(p.solveCaptcha).not.toHaveBeenCalled();
      expect(p.fetcher).toHaveBeenCalledTimes(2);
    }
    const p = portal();
    vi.mocked(p.fetcher).mockImplementationOnce(async () => new Response('portal')).mockImplementationOnce(async () => image()).mockImplementationOnce(async () => new Response('<html>changed</html>'));
    await expect(p.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(p.fetcher).toHaveBeenCalledTimes(3);
  });

  it('reports the portal behind Turnstile as a challenge before reading any CAPTCHA', async () => {
    const fetcher = vi.fn(async () => new Response('<form id="form-rastreamento" method="post"><div id="captcha" class="cf-turnstile"></div></form>')) as unknown as typeof fetch;
    await expect(new CorreiosTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', message: 'Correios requires a Turnstile browser check' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('asks the browser service for the reply its Turnstile search binds to the number, after a challenge only', async () => {
    const API = 'https://rastreamento.correios.com.br/app/resultado.php';
    const turnstile = () => vi.fn(async () => new Response('<div id="captcha" class="cf-turnstile"></div>')) as unknown as typeof fetch;
    const browser = (...captured: Partial<TrawlCapturedResponse>[]) => ({ scrape: vi.fn(async () => ({ statusCode: 200,
      capturedResponses: captured.map((row) => ({ url: API, status: 200, headers: {}, body: JSON.stringify(fixture), truncated: false,
        base64Encoded: false, error: null, trackingNumberSubmitted: NUMBER, ...row })) })) });
    const answered = browser({});
    const recorder = { step: vi.fn(), lookup: vi.fn() };
    const result = await new CorreiosTracker({ fetcher: turnstile(), trawl: answered as unknown as TrawlClient, recorder }).fetch(NUMBER);
    expect(result.status).toBe('delivered');
    expect(recorder.step.mock.calls.map(([step]) => [step.step, step.outcome])).toEqual([['direct', 'challenge'], ['trawl', 'ok']]);
    expect(recorder.lookup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ carrier: 'correios-br',
      finalStep: 'trawl', outcome: 'ok', errorType: null, attempts: 2 }));
    expect(answered.scrape).toHaveBeenCalledWith(expect.objectContaining({ url: `${HOME}?objetos=${NUMBER}`, captureResponses: [API], skipHttp: true }),
      expect.objectContaining({ provider: 'Correios', requireSolved: false }));
    for (const [captured, kind] of [[[], 'challenge'], [[{ trackingNumberSubmitted: 'BB000000005BR' }], 'challenge'],
      [[{ status: 403, body: null }], 'challenge'], [[{ status: 429, body: null }], 'rate_limited'], [[{ truncated: true }], 'transport'],
      [[{ body: '{"erro":true,"mensagem":"Objeto não encontrado"}' }], 'indeterminate'], [[{ body: '<html>' }], 'schema']] as const) {
      const trawl = browser(...captured);
      await expect(new CorreiosTracker({ fetcher: turnstile(), trawl: trawl as unknown as TrawlClient }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(trawl.scrape).toHaveBeenCalledTimes(1);
    }
    // A refusal that is not Turnstile's is not the browser's to retry.
    const unused = browser({});
    const throttled = vi.fn(async () => new Response('busy', { status: 429 })) as unknown as typeof fetch;
    await expect(new CorreiosTracker({ fetcher: throttled, trawl: unused as unknown as TrawlClient }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(unused.scrape).not.toHaveBeenCalled();
  });

  it('keeps endpoint absence inconclusive and preserves challenge, throttle and network errors', async () => {
    for (const [status, kind] of [[404, 'indeterminate'], [410, 'indeterminate'], [403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const) {
      const fetcher = vi.fn(async () => new Response('unavailable', { status })) as unknown as typeof fetch;
      await expect(new CorreiosTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn(async () => { throw new Error('Network failure'); }) as unknown as typeof fetch;
    await expect(new CorreiosTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves cancellation before requests, through HTTP and during OCR without a later query', async () => {
    const pre = portal();
    await expect(pre.tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);
    expect(pre.fetcher).not.toHaveBeenCalled();
    await expect(pre.tracker.fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(pre.fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url, init) => {
      init?.signal?.throwIfAborted();
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
      return new Response('unused');
    }) as unknown as typeof fetch;
    const interrupted = new CorreiosTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal });
    controller.abort();
    await expect(interrupted).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const p = portal();
    const solver = vi.fn(async (_bytes: Uint8Array, signal: AbortSignal): Promise<string> => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const result = new CorreiosTracker({ fetcher: p.fetcher, solveCaptcha: solver }).fetch(NUMBER, { budgetMs: 25 });
    await expect(result).rejects.toBeInstanceOf(Error);
    expect(solver).toHaveBeenCalledTimes(1);
    expect(p.calls).toHaveLength(2);
    expect(p.calls.some((call) => call.url.pathname === '/app/resultado.php')).toBe(false);
  });
});

it('exposes stable diagnostic kinds without treating bad clocks as negatives', () => {
  try { parseCorreios({ erro: true, mensagem: 'Período inválido' }, NUMBER); }
  catch (error) { expect(carrierErrorKind(error)).toBe('indeterminate'); }
});
