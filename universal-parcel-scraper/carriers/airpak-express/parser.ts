import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseGetOnline, type GetOnlineMember } from '../skynet-worldwide/getonline.js';
import { airpakStage } from './status.js';

export const PROVIDER = 'Airpak Express';
/** The GETOnline page on Airpak's own host, where its tracking box leads. */
export const AIRPAK_TRACKER = 'https://tracking.airpak-express.com/go/plm-tracking';
// Connote numbers are twelve digits, and eleven on some domestic ones.
const NUMBER = /^\d{11,12}$/;
// A run of zeros is a placeholder, not a connote.
const PLACEHOLDER = /^0+$/;

/** An Airpak connote number: eleven or twelve digits, not all zeros. */
export function normalizeAirpakNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number) || PLACEHOLDER.test(number)) throw new InvalidInputError(PROVIDER, 'Airpak connote numbers are eleven or twelve digits');
  return number;
}

export const AIRPAK: GetOnlineMember = {
  carrier: 'airpak-express', provider: PROVIDER, name: 'Airpak', stid: 'airpak', tracker: AIRPAK_TRACKER,
  normalize: normalizeAirpakNumber, stage: airpakStage,
};

/** The tracker's page for one connote, `go/plm-tracking?stid=airpak&cn=`. */
export const parseAirpak = (html: string, rawNumber: string): CarrierResult => parseGetOnline(html, rawNumber, AIRPAK);
