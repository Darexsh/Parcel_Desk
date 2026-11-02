import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { countryTimeZone } from '../../core/time/index.js';

export interface PocztaPolskaPartnerClock { zone: string; basis: 'carrier' | 'destination' }

/**
 * The clock of the partner post whose scans the tracker relays. Posts relay
 * scans on the scanning office's wall clock: an item another country's post
 * numbered is posted and sent off there, and one Poczta Polska numbered for
 * abroad meets the destination's post. A Latvian item's relayed posting and
 * departure show Latvijas Pasts's instants on Riga's clock. None for a country
 * with several clocks, Spain's and Portugal's islands among them.
 */
export function pocztaPolskaPartnerClock(number: string, destination: unknown): PocztaPolskaPartnerClock | null {
  const issuer = isValidS10TrackingNumber(number) ? number.slice(-2) : '';
  const [country, basis]: [string, PocztaPolskaPartnerClock['basis'] | ''] = issuer && issuer !== 'PL' ? [issuer, 'carrier']
    : typeof destination === 'string' && destination !== 'PL' ? [destination, 'destination'] : ['', ''];
  const zone = basis && country !== 'ES' && country !== 'PT' ? countryTimeZone(country) : null;
  return zone && basis ? { zone, basis } : null;
}
