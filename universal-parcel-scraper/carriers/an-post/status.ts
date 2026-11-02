import { classifyWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/** The website's wording for a delivery attempt (code 16), chosen from the attempt's reason. */
export const ATTEMPT_DELIVERED = 'Your item was delivered';
export const ATTEMPT_MADE = 'We attempted to deliver your item';

interface CodeStage {
  stage: Stage;
  /** Stages the scan's wording may narrow a broad app category to. */
  narrower?: readonly Stage[];
}

const each = (codes: readonly number[], entry: CodeStage) => codes.map(code => [code, entry] as const);

const CODES: ReadonlyMap<number, CodeStage> = new Map<number, CodeStage>([
  // Seen in live histories.
  [35, { stage: 'registered' }],
  [15, { stage: 'accepted' }],
  [48, { stage: 'accepted' }],
  [49, { stage: 'in_transit' }],
  [67, { stage: 'in_transit' }],
  [4, { stage: 'out_for_delivery' }],
  [14, { stage: 'delivered' }],
  [70, { stage: 'ready_for_pickup' }],
  // The app's own categories (traceCodeToTrackedItemStatus). 42 is the
  // website's delivery with a photo or signature; 83, 86 and 87 its customs
  // charge raised, refused and expired; 32 and 37 its acceptance codes.
  ...each([42], { stage: 'delivered' }),
  ...each([13], { stage: 'failed_attempt' }),
  ...each([7, 9, 64, 65, 66, 83, 86, 87], { stage: 'customs' }),
  ...each([6, 32, 36, 37, 41], { stage: 'accepted' }),
  // The app's "in transit" and "sorting" also hold codes 4 and 70, and its
  // "return to sender" holds returns still under way.
  ...each([1, 5, 8, 19, 40, 43, 44, 45, 46, 47, 50, 51, 52, 57, 63, 68, 69, 73, 78, 79, 85],
    { stage: 'in_transit', narrower: ['out_for_delivery', 'ready_for_pickup'] }),
  ...each([53, 55, 56, 71, 75, 76, 77], { stage: 'returned', narrower: ['exception'] }),
]);

/**
 * Code 52 names the office the item is in. Live, a post office one came after
 * a delivery to that office and before the collection there, signed for: the
 * item waits at the counter, not in a sorting office.
 */
const POST_OFFICE = /^your delivery is in (\S.{0,120}?,? post office)\.?$/i;

/** The post office a code 52 scan says the item waits in, as worded. */
export function anPostPostOffice(code: number, description: string): string | undefined {
  return code === 52 ? POST_OFFICE.exec(description)?.[1] : undefined;
}

export interface AnPostStage {
  stage: Stage;
  source: string;
}

const wordingOf = (text: string): AnPostStage | undefined => {
  const classified = classifyWording(text, 'pending');
  return classified.source === 'none' ? undefined : classified;
};

/**
 * A scan's stage from its trace code. A delivery attempt is delivered when the
 * website words it so; codes nobody classified fall to the shared wording rules.
 */
export function anPostScanStage(code: number, description: string): AnPostStage | undefined {
  if (code === 16) return { stage: description === ATTEMPT_DELIVERED ? 'delivered' : 'failed_attempt', source: 'carrier_map' };
  if (anPostPostOffice(code, description)) return { stage: 'ready_for_pickup', source: 'carrier_map' };
  const known = CODES.get(code);
  const wording = wordingOf(description);
  if (!known) return wording;
  if (wording && known.narrower?.includes(wording.stage)) return wording;
  return { stage: known.stage, source: 'carrier_map' };
}

/**
 * What the map says about one scan: its trace code, as the adapter writes it,
 * and the scan's wording. Every scan carries a code, so wording alone gets
 * nothing; codes the map does not know take their stage from the shared
 * wording rules, which stay open for review.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (!code || !/^(?:0|[1-9]\d{0,3})$/.test(code)) return undefined;
    const trace = Number(code);
    if (trace === 16) return wording === normalizeStatusWording(ATTEMPT_DELIVERED) ? 'delivered' : 'failed_attempt';
    return CODES.has(trace) ? anPostScanStage(trace, wording)?.stage : undefined;
  },
  gaps: [],
};

// The live wording of each code, and the website's two attempt outcomes. The
// summary repeats the newest scan's wording without its code, so a summary
// ahead of the history is staged as that scan would be.
const WORDINGS: ReadonlyMap<string, readonly [number, string]> = new Map(([
  [35, 'We have received information about your incoming item from the sender'],
  [15, 'Your item has been handed to An Post'],
  [48, 'We have your item and will process it for delivery'],
  [5, 'Your item is being sent internationally. We will aim to show tracking updates as they become available, or visit the local delivery provider website for updates.'],
  [40, 'Your item arrived abroad. We will aim to show tracking information from the receiving post, but would recommend tracking the item further on their site'],
  [49, 'Your item is going to a sorting office for delivery in'],
  [67, 'Your item is being sorted by the local delivery provider'],
  [68, 'Your item is in the sorting office of the local delivery provider'],
  [73, 'Your item is being prepared for delivery'],
  [4, 'Your item is out for delivery'],
  [13, 'Your item was not collected within the specified timeframe. This item will now be returned to sender.'],
  [14, 'Your item has been delivered'],
  [14, 'Your item has been delivered to your safe spot.'],
  [70, 'Your item is now available for collection'],
  [16, ATTEMPT_DELIVERED],
  [16, ATTEMPT_MADE],
] as const).map(([code, wording]): [string, readonly [number, string]] => [normalizeStatusWording(wording), [code, wording]]));

/**
 * The stage of An Post's own wording without its code, as aggregators relay
 * its scans; any other wording gets none.
 */
export function anPostWordingStage(text: string): Stage | undefined {
  const known = WORDINGS.get(normalizeStatusWording(text));
  return known ? anPostScanStage(...known)?.stage : undefined;
}

/** The summary's status, which repeats the newest scan's activity without its code. */
export function anPostSummaryStage(text: string): AnPostStage | undefined {
  const known = WORDINGS.get(normalizeStatusWording(text));
  if (known) return anPostScanStage(...known);
  if (anPostPostOffice(52, text)) return anPostScanStage(52, text);
  return wordingOf(text);
}
