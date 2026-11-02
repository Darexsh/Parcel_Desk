import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { suratKargoStage } from './status.js';

export const PROVIDER = 'Sürat Kargo';
export const SURAT_ORIGIN = 'https://www.suratkargo.com.tr';
export const SURAT_PAGE = '/KargoTakip/';
export const SURAT_HISTORY = '/KargoTakip/Default/KargoHareketi';
export const SURAT_BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment)|_cf_chl_opt/i;

export function suratKargoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^\d{14}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Sürat Kargo requires a fourteen-digit tracking number');
}

/** Tokens belong only to this whole-number GET; the visible identity is masked by the carrier. */
export function suratHistoryTokens(html: string, raw: string, requestedUrl: string): string[] {
  const number = suratKargoNumber(raw);
  const url = new URL(requestedUrl);
  if (url.origin !== SURAT_ORIGIN || url.pathname !== SURAT_PAGE || url.searchParams.getAll('kargotakipno').length !== 1
    || url.searchParams.get('kargotakipno') !== number) throw new IndeterminateError(PROVIDER, 'Sürat Kargo lookup is not bound to the whole number');
  if (SURAT_BLOCKED.test(html.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'Sürat Kargo answered with a block page');
  }
  const $ = load(html);
  const buttons = $('.js-hareket-getir');
  if (!buttons.length) {
    if ($('input[name="UserCaptchaInput"]').length) throw new ChallengeError(PROVIDER, 'Sürat Kargo requires verification');
    if ($('input[name="kargotakipno"]').length) throw new NoHistoryError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Sürat Kargo returned no tracking page');
  }
  const identityRows = $('thead tr').filter((_, row) => {
    const cells = $(row).children('th');
    return cells.length === 4 && clean(cells.eq(3).text(), 100) === 'Kargo Takip No';
  });
  if (identityRows.length !== 1) throw new SchemaError(PROVIDER, 'Sürat Kargo returned no shipment identity');
  const masked = identityRows.parent().next('tbody').find('tr').first().children('td').eq(3).text().trim();
  if (masked !== number && masked !== `${number.slice(0, 3)}${'*'.repeat(11)}`) throw new IndeterminateError(PROVIDER, 'Sürat Kargo answered for another shipment');
  const tokens = new Set<string>();
  for (const button of buttons.toArray()) {
    const token = $(button).attr('data-token') ?? '';
    const endpoint = $(button).closest('[data-hareket-url]').attr('data-hareket-url');
    if (!/^[a-f0-9]{32}$/i.test(token) || endpoint !== SURAT_HISTORY) throw new SchemaError(PROVIDER, 'Sürat Kargo changed its history access flow');
    tokens.add(token);
  }
  if (!tokens.size || tokens.size > 20) throw new SchemaError(PROVIDER, 'Sürat Kargo returned too many shipment pieces');
  return [...tokens];
}

export function parseSuratHistory(payload: unknown): CarrierEvent[] {
  if (!Array.isArray(payload) || payload.length > 500) throw new SchemaError(PROVIDER, 'Sürat Kargo returned an invalid history');
  if (!payload.length) throw new NoHistoryError(PROVIDER);
  const events = payload.map((row): CarrierEvent => {
    if (!isRecord(row) || typeof row.HareketTarihi !== 'string' || !/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/.test(row.HareketTarihi)
      || typeof row.HareketTipi !== 'string' || !row.HareketTipi.trim() || row.HareketTipi.length > 2000
      || (row.HareketYeri != null && typeof row.HareketYeri !== 'string')) throw new SchemaError(PROVIDER, 'Sürat Kargo returned an invalid scan');
    const date = firstOccurrence(DateTime.fromFormat(row.HareketTarihi, 'dd.MM.yyyy HH:mm:ss', { zone: 'Europe/Istanbul' }));
    if (!date.isValid) throw new SchemaError(PROVIDER, 'Sürat Kargo returned an invalid scan calendar');
    const description = clean(row.HareketTipi, 320);
    const location = clean(row.HareketYeri, 160);
    const staged = suratKargoStage(description);
    return { time: date.toISO({ suppressMilliseconds: true }), local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      time_zone: 'Europe/Istanbul', time_zone_basis: 'carrier', description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
  return events.sort((a, b) => b.time!.localeCompare(a.time!));
}

/** A delivered piece never completes a shipment whose other pieces remain active. */
export function suratKargoResult(histories: readonly CarrierEvent[][]): CarrierResult {
  if (!histories.length || histories.some(events => !events.length)) throw new NoHistoryError(PROVIDER);
  const active = histories.map(events => events[0]!).filter(event => event.stage !== 'delivered');
  const candidates = active.length ? active : histories.map(events => events[0]!);
  const current = [...candidates].sort((a, b) => b.time!.localeCompare(a.time!))[0]!;
  const seen = new Set<string>();
  const events = histories.flat().sort((a, b) => b.time!.localeCompare(a.time!)).filter(event => {
    const key = JSON.stringify(event); if (seen.has(key)) return false; seen.add(key); return true;
  });
  return { status: current.stage ? languageStageStatus(current.stage as Stage) : 'unknown',
    ...(current.stage ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: current.description!, last_update: current.time, last_update_local: current.local_time,
    expected_delivery: null, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(!active.length ? { delivered_at: current.time } : {}) };
}
