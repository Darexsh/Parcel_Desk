import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeYalidineNumber, parseYalidine, yalidineRequestNumber } from './parser.js';
import { yalidineMappedStage } from './status.js';

const NUMBER = 'YALZQ8H7J';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const modify = (change: (page: ReturnType<typeof load>) => void) => { const $ = load(fixture()); change($); return $.html(); };

describe('Yalidine guest history parser', () => {
  it('retains whole-number history, current state, places and validated yearless clocks', () => {
    const result = normalizeCarrierResult(parseYalidine(fixture(), NUMBER));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Livré', last_update: null });
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toEqual({ provider_time_text: 'jeudi 01 janvier à 10:37', description: 'Livré',
      location: 'Example delivery centre', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.at(-1)).toEqual({ provider_time_text: 'mercredi 31 décembre à 08:11', description: 'En préparation',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events?.every(event => event.time === undefined && event.local_time === undefined)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(result.last_update_local).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Actuel');
  });

  it.each(['yal-ZQ8H7J', 'yal zq8h7j', 'YALZQ8H7J'])('uses the existing detector normalization for %s', raw => {
    expect(normalizeYalidineNumber(raw)).toBe(NUMBER);
    expect(yalidineRequestNumber(raw)).toBe('yal-ZQ8H7J');
  });

  it.each(['', 'YALZQ8H7', 'YALZQ8H7JX', 'ELDZQ8H7J', '777444222', 'A'.repeat(100)])('rejects identifiers outside the own-label rule', raw => {
    expect(() => parseYalidine(fixture(), raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('does not use a form echo as result identity', () => {
    const html = modify($ => { $('.card-header').first().text('Le suivi du colis'); $('input[name="tracking"]').val(NUMBER); });
    expect(() => parseYalidine(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects another whole result number and extended heading identities', () => {
    expect(() => parseYalidine(fixture().replace('YAL-ZQ8H7J', 'YAL-MB7K2P'), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYalidine(fixture().replace('YAL-ZQ8H7J', 'YAL-ZQ8H7JX'), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest unknown wording without borrowing an older mapped stage', () => {
    const html = modify($ => { $('tbody tr').first().children('td').eq(1).html('New carrier wording <span>Actuel</span>'); });
    expect(parseYalidine(html, NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'New carrier wording' });
    expect(parseYalidine(html, NUMBER).current_stage).toBeUndefined();
    expect(parseYalidine(html, NUMBER).events?.[1]?.stage).toBe('out_for_delivery');
  });

  it('deduplicates exact scans while retaining distinct wording at the same yearless clock', () => {
    const html = modify($ => { const row = $('tbody tr').eq(2); row.after(row.clone()); row.after(row.clone().find('td').eq(1).text('Centre').end().end()); });
    const result = parseYalidine(html, NUMBER);
    expect(result.events).toHaveLength(6);
    expect(result.events?.slice(2, 4).map(event => event.description)).toEqual(['Reçu à Wilaya', 'Centre']);
  });

  it.each(['mardi 31 avril à 10:15', 'lundi 00 janvier à 10:15', 'samedi 32 janvier à 10:15', 'lundi 01 janvier à 24:00',
    'mardi 01 janvier à 10:60', 'weekday 01 janvier à 10:00', 'lundi 01 unknown à 10:00', 'lundi 01 janvier 2026 à 10:00', ''])('rejects malformed clock %s without choosing a year', raw => {
    const html = modify($ => { $('tbody tr').first().children('td').first().text(raw); });
    expect(() => parseYalidine(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('accepts a yearless leap day without asserting which year it belongs to', () => {
    const html = modify($ => { $('tbody tr').first().children('td').first().text('mardi 29 février à 10:00'); });
    expect(parseYalidine(html, NUMBER).events?.[0]).toMatchObject({ provider_time_text: 'mardi 29 février à 10:00' });
    expect(parseYalidine(html, NUMBER).last_update).toBeNull();
  });

  it('reads only the explicit negative of a bound form reply', () => {
    expect(() => parseYalidine(fixture('not-found'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYalidine(fixture('not-found').replace("Le colis que vous avez saisi n'existe pas.", 'Veuillez réessayer.'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseYalidine(fixture('not-found').replace("Le colis que vous avez saisi n'existe pas.", 'Service indisponible.'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects conflicting positive and negative replies', () => {
    const html = modify($ => { $('#about > .container').prepend('<div class="alert alert-danger"><strong>Affichage impossible</strong><br>Le colis que vous avez saisi n\'existe pas.</div>'); });
    expect(() => parseYalidine(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['card', 'heading', 'table', 'headers', 'cells', 'form', 'badge', 'older-badge', 'extra-badge'])('rejects ambiguous or changed %s structure', variant => {
    const html = modify($ => {
      if (variant === 'card') $('#about > .container').append($('#about > .container > .card').clone());
      if (variant === 'heading') $('.card-header').first().remove();
      if (variant === 'table') $('.card-body').append($('table').clone());
      if (variant === 'headers') $('th').first().text('Changed date');
      if (variant === 'cells') $('tbody tr').first().children('td').last().remove();
      if (variant === 'form') $('form').remove();
      if (variant === 'badge') $('tbody span').remove();
      if (variant === 'older-badge') $('tbody span').appendTo($('tbody tr').eq(1).children('td').eq(1));
      if (variant === 'extra-badge') $('tbody tr').first().children('td').eq(1).append('<span>Actuel</span>');
    });
    expect(() => parseYalidine(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a bound empty table inconclusive and bounds history and body size', () => {
    expect(() => parseYalidine(modify($ => { $('tbody').empty(); }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYalidine(modify($ => { const row = $('tbody tr').eq(1); for (let index = 0; index < 500; index++) $('tbody').append(row.clone()); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYalidine('x'.repeat(1_000_001), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not retain unrelated form or page details', () => {
    const html = modify($ => { $('body').append('<aside>INVENTED RECIPIENT DETAIL</aside>'); $('form').append('<input name="private" value="SYNTHETIC-SESSION-VALUE">'); });
    const result = JSON.stringify(parseYalidine(html, NUMBER));
    expect(result).not.toContain('RECIPIENT'); expect(result).not.toContain('SESSION');
  });

  it.each(['<title>Just a moment...</title>', '<script>window._cf_chl_opt={}</script>'])('retains challenge classification', html => {
    expect(() => parseYalidine(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('maps the existing source wordings without fabricating mappings for new wording', () => {
    const entries = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')).entries;
    for (const entry of entries) expect(yalidineMappedStage(entry.wording)).toBe(entry.stage);
    expect(yalidineMappedStage('Unknown operational wording')).toBeUndefined();
  });
});
