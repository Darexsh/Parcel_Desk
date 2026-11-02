/**
 * PostNL status vocabulary.
 *
 * Every event carries a `category` token next to its localized
 * `status_description`. Categories are the primary signal. The English
 * labels refine the overloaded Processing, Transit and Customs categories,
 * which also cover sorting, acceptance and customs release.
 * Categories are matched case-insensitively after trimming, because the
 * international tracker has been seen returning them capitalized
 * ("Pre-advised") and lower case in the same history.
 *
 * `unsuccesfull` is PostNL's own spelling; the corrected spelling is mapped
 * alongside it so a fix upstream does not silently lose the classification.
 */
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

const CATEGORY_STATUS = new Map<string, ClassifiedStatus>([
  ['pre-advised', { status: 'pending', stage: 'registered' }],
  ['preparing', { status: 'pending', stage: 'registered' }],
  ['processing', { status: 'in_transit', stage: 'accepted' }],
  ['departed', { status: 'in_transit', stage: 'in_transit' }],
  ['arrived', { status: 'in_transit', stage: 'in_transit' }],
  ['in transit', { status: 'in_transit', stage: 'in_transit' }],
  ['transit', { status: 'in_transit', stage: 'in_transit' }],
  ['customs', { status: 'in_transit', stage: 'customs' }],
  ['out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['pick-up point', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['delivered', { status: 'delivered', stage: 'delivered' }],
  ['unsuccesfull', { status: 'exception', stage: 'failed_attempt' }],
  ['unsuccessful', { status: 'exception', stage: 'failed_attempt' }],
  ['undelivered', { status: 'exception', stage: 'failed_attempt' }],
  ['returned', { status: 'exception', stage: 'returned' }],
  ['exception', { status: 'exception', stage: 'exception' }],
]);

export { CATEGORY_STATUS as POSTNL_STATUS };

const IN_TRANSIT: ClassifiedStatus = { status: 'in_transit', stage: 'in_transit' };

/** Exact English labels that refine an overloaded category, lowercase without final punctuation. */
const LABEL_STATUS = new Map<string, ReadonlyMap<string, ClassifiedStatus>>([
  ['customs', new Map([['the item is released by customs', IN_TRANSIT]])],
  ['processing', new Map([
    ['the item has arrived at the domestic sorting centre', IN_TRANSIT],
    ['the item is at the local sorting centre', IN_TRANSIT],
    ['the item is on transport to the local sorting centre', IN_TRANSIT],
    ['the item is at the local delivery office', IN_TRANSIT],
    ['driver is en route to the pickup location', IN_TRANSIT],
    ['the item is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ])],
  // PostNL's own acceptance scans.
  ['transit', new Map(['consignment received at the postnl acceptance centre',
    'the shipment is handed over in bulk final acceptance of the item to be confirmed',
  ].map((label): [string, ClassifiedStatus] => [label, { status: 'in_transit', stage: 'accepted' }]))],
  // "Will be returned" can still end in a new delivery attempt; these two are the return itself.
  ['undelivered', new Map(['undeliverable item, has been returned to shipper', 'the item has been returned and arrived at postnl',
  ].map((label): [string, ClassifiedStatus] => [label, { status: 'exception', stage: 'returned' }]))],
]);

/** A category as the maps key it: trimmed, in lower case. */
function categoryKey(category: unknown): string {
  return (typeof category === 'string' ? category : '').trim().toLocaleLowerCase('en-US');
}

/** The status and stage for one PostNL event category, or undefined when unmapped. */
export function postNLStatus(category: unknown, description?: unknown): ClassifiedStatus | undefined {
  const code = categoryKey(category);
  const label = (typeof description === 'string' ? description : '').trim().toLocaleLowerCase('en-US').replace(/[.!]+$/, '');
  return LABEL_STATUS.get(code)?.get(label) ?? CATEGORY_STATUS.get(code);
}

/**
 * Labels of PostNL's domestic tracker seen on parcels, lowercase without final
 * punctuation: those the shared wording rules read wrong, and its pre-advice and
 * sorting scans.
 * Its observations carry no category.
 */
const DOMESTIC_STAGE = new Map<string, Stage>([
  ['shipment expected, but not yet arrived or processed at postnl', 'registered'],
  ['not yet processed by postnl', 'registered'],
  ['shipment received by postnl', 'accepted'],
  ['driver is en route', 'out_for_delivery'],
  ['shipment sorted in sorting centre', 'in_transit'],
  ['shipment has been sorted', 'in_transit'],
  ['shipment is ready for transport to the country of destination', 'in_transit'],
]);

/** The stage of one domestic tracker observation, or undefined when unmapped. */
export function postNLDomesticStage(description: string): Stage | undefined {
  return DOMESTIC_STAGE.get(description.trim().toLocaleLowerCase('en-US').replace(/[.!]+$/, ''));
}

/**
 * An international scan's provider code: its status number, a slash and its category as the map
 * keys it ("37/delivered"), since the category stages the scan. A scan without a category keeps
 * its number alone.
 */
export function postNLCode(status: string, category: unknown): string {
  const key = categoryKey(category).slice(0, 64);
  return key ? `${status}/${key}` : status;
}

/**
 * What the map says about one scan. An international scan stored with its category is staged by
 * that category and its label, the stored wording, as the adapter stages it. A domestic
 * observation, or an international scan stored with its status number alone, is read by the
 * domestic tracker's labels.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    const category = /^\d{1,8}\/(.+)$/s.exec(code ?? '')?.[1];
    return category === undefined ? postNLDomesticStage(wording) : postNLStatus(category, wording)?.stage;
  },
  gaps: [],
};
