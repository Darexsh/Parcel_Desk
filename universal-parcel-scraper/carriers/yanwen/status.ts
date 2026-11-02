import type { CarrierStatus } from '../../core/result/index.js';
import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const WORDING = new Map<string, ClassifiedStatus>([
  ['Delivered.', { status: 'delivered', stage: 'delivered' }],
  ['Shipment out for delivery.', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['<User not at home>', { status: 'exception', stage: 'failed_attempt' }],
  ['<wrong address>', { status: 'exception', stage: 'failed_attempt' }],
  ['Arrived.', { status: 'in_transit', stage: 'in_transit' }],
  ['Received.', { status: 'in_transit', stage: 'in_transit' }],
  ['Batch delivery to carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Pick up by local carrier at destination port', { status: 'in_transit', stage: 'in_transit' }],
  ['Custom Clearance in process - Import', { status: 'in_transit', stage: 'customs' }],
  ['International shipment release - Import', { status: 'in_transit', stage: 'in_transit' }],
  ['International shipment release - Export', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of destination - Arrival', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of departure - Departure', { status: 'in_transit', stage: 'in_transit' }],
  ['Port of departure - Received by carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at domestic terminal station', { status: 'in_transit', stage: 'in_transit' }],
  ['Yanwen facility - Outbound', { status: 'in_transit', stage: 'in_transit' }],
  ['Yanwen Pickup Scan', { status: 'in_transit', stage: 'accepted' }],
  // Intake lines written in the seconds after the pickup scan, the partner's label
  // among them: the parcel is in Yanwen's hands and has not moved yet.
  ['Processing information input', { status: 'in_transit', stage: 'accepted' }],
  ['Shipment data received', { status: 'in_transit', stage: 'accepted' }],
  ['shipping label created', { status: 'in_transit', stage: 'accepted' }],
  ['Shipment order created', { status: 'in_transit', stage: 'accepted' }],
  ['Order processed by shipper', { status: 'pending', stage: 'registered' }],
  ['Order Submited.', { status: 'pending', stage: 'registered' }],
  ['Waybill Generated', { status: 'pending', stage: 'registered' }],
  ['Shipping Order Created.', { status: 'pending', stage: 'registered' }],
  // Last-mile wording relayed without codes. Pre-advice lines come before the
  // parcel leaves China; a partner's acceptance follows Yanwen's own pickup
  // scan, so it is a handover rather than the parcel's acceptance.
  ['Pre-Shipment, USPS Awaiting Item', { status: 'pending', stage: 'registered' }],
  ['Shipment information received', { status: 'pending', stage: 'registered' }],
  ['Registered parcel data, parcel not dispatched yet', { status: 'pending', stage: 'registered' }],
  ['Shipping information received. Your parcel is on its way to UniUni for delivery to you', { status: 'pending', stage: 'registered' }],
  ['Votre Colissimo va bientôt nous être confié ! Il est en cours de préparation chez votre expéditeur.', { status: 'pending', stage: 'registered' }],
  ['Accepted at USPS Origin Facility', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been accepted by delivery carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has arrived at sorting center', { status: 'in_transit', stage: 'in_transit' }],
  // A partner's manifest as the parcel leaves Yanwen's facility, then the destination leg's
  // release from customs, intake and arrival at the delivery office.
  ['Manifest created', { status: 'in_transit', stage: 'in_transit' }],
  // DHL's own line once Yanwen's facility has sent the parcel on to it.
  ['The shipment is in transit to DHL', { status: 'in_transit', stage: 'in_transit' }],
  // A destination partner's own record: its order before the parcel leaves China, then
  // its intake and transfer scans after Yanwen's batch handover at the destination port.
  ['Shipment created', { status: 'pending', stage: 'registered' }],
  ['Shipment under processing at origin hub', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment received', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment despatched to transshipment hub', { status: 'in_transit', stage: 'in_transit' }],
  ['Out customs authorities', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at destination', { status: 'in_transit', stage: 'in_transit' }],
  ['Handled by local carrier', { status: 'in_transit', stage: 'in_transit' }],
  // The destination partner's departure from its hub after the batch handover and its arrival at the
  // next depot, as DPD Romania words them.
  ['Departure Scan', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrival Scan', { status: 'in_transit', stage: 'in_transit' }],
  // The destination partner's post office holding the parcel for the recipient to collect.
  ['Prepared for Self-collecting by Consignee', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['Transport to delivery centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at delivery centre', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has been processed at sorting center and ready for shipping', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has departed from the transit origin', { status: 'in_transit', stage: 'in_transit' }],
  ['Your shipment has arrived at the transit destination', { status: 'in_transit', stage: 'in_transit' }],
  ['Parcel dispatched to be delivered', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['Your shipment is out for delivery', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  // Nova Poshta's leg in Ukraine, from the flight out of Hong Kong through customs at the border
  // to its branch, relayed in Yanwen's English. Customs holds the parcel at its terminal until the
  // clearance.
  ['He left the airport', { status: 'in_transit', stage: 'in_transit' }],
  ['An order for delivery to the destination country has been issued', { status: 'in_transit', stage: 'in_transit' }],
  ['The consignment arrived in the destination country', { status: 'in_transit', stage: 'in_transit' }],
  ['Shipment is in transit', { status: 'in_transit', stage: 'in_transit' }],
  ['Delivered to customs terminal', { status: 'in_transit', stage: 'customs' }],
  ['Customs clearance is complete', { status: 'in_transit', stage: 'in_transit' }],
  ['Left the customs terminal', { status: 'in_transit', stage: 'in_transit' }],
  ['The shipment goes to the recipient', { status: 'in_transit', stage: 'in_transit' }],
  ['At the terminal of the destination city', { status: 'in_transit', stage: 'in_transit' }],
  ['In the New Post Office', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  // The branch's hold ending uncollected: the parcel goes to storage, unclaimed, then to the
  // unclaimed cargo area. Its "Delivery is not possible" is the attempt Yanwen's Undelivered
  // category names.
  ['Sent to storage', { status: 'exception', stage: 'exception' }],
  ['Unsolicited shipment', { status: 'exception', stage: 'exception' }],
  ['Delivery is not possible', { status: 'exception', stage: 'failed_attempt' }],
  ['Parcel accepted in the unclaimed cargo area', { status: 'exception', stage: 'exception' }],
  // A leg into Canada. Yanwen's terminal tenders the parcel to the line-haul minutes after its
  // outbound scan, before the export release, so the tender is no delivery round. Then the
  // release from customs, the partner's arrival and the delivering carrier's intake and terminals,
  // until its driver loads the parcel for the round, which Yanwen files as out for delivery.
  ['Tendered for Delivery', { status: 'in_transit', stage: 'in_transit' }],
  ['Cleared Customs', { status: 'in_transit', stage: 'in_transit' }],
  ['Scanned arrived at FB Canada', { status: 'in_transit', stage: 'in_transit' }],
  ['Received from Prior Carrier', { status: 'in_transit', stage: 'in_transit' }],
  ['Arrived at Terminal Location', { status: 'in_transit', stage: 'in_transit' }],
  ['Loaded on Truck', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
]);

// Yanwen files each parcel under a category its status filter names:
// 制单完成 Info_Received, 运输途中 In_Transportation, 正在派送 Out_For_Delivery,
// 到达待取 Available_For_Pick_Up, 投递成功 Delivered, 投递失败 Undelivered,
// 包裹异常 Exception and 包裹退回 Returned. In transit spans customs and the
// partners' legs, so the newest scan names that stage. 追踪结束 End_of_Tracking
// only says Yanwen stopped following the parcel, and 查询不到 Not_Found is absence.
const CATEGORY = new Map<string, { status: CarrierStatus; stage?: Stage }>([
  ['制单完成', { status: 'pending', stage: 'registered' }],
  ['运输途中', { status: 'in_transit' }],
  ['正在派送', { status: 'out_for_delivery', stage: 'out_for_delivery' }],
  ['到达待取', { status: 'out_for_delivery', stage: 'ready_for_pickup' }],
  ['投递成功', { status: 'delivered', stage: 'delivered' }],
  ['投递失败', { status: 'exception', stage: 'failed_attempt' }],
  ['包裹异常', { status: 'exception', stage: 'exception' }],
  ['包裹退回', { status: 'exception', stage: 'returned' }],
]);

// The timeline marks the delivery scan with its LM40 milestone icon, whatever
// wording the last-mile carrier used for it.
const DELIVERY_ICON = 'LM40';

// Partner wording can prefix its facility in full-width brackets, or its
// country's code and a dot: "UA.In the New Post Office". Removing those
// observed prefixes makes the remaining exact wording reusable. A scan that is
// only the code keeps it.
const withoutPrefix = (description: string) => description.replace(/^【[^】]*】\s*/, '').replace(/^[a-z]{2}\.(?=\S)/i, '').trim();

export function yanwenStatus(description: string, code?: string): ClassifiedStatus | undefined {
  if (code === DELIVERY_ICON) return { status: 'delivered', stage: 'delivered' };
  return WORDING.get(withoutPrefix(description));
}

const STAGE_BY_WORDING = new Map([...WORDING].map(([wording, { stage }]) => [normalizeStatusWording(wording), stage]));

/** What the map says about one scan by its milestone icon, the only code it keeps, else its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code === DELIVERY_ICON ? 'delivered' : STAGE_BY_WORDING.get(withoutPrefix(wording))),
  gaps: [{ wording: 'ua.', note: "A partner's scan in Ukraine that Yanwen relays as its country's code alone, without words: it names no stage." }],
};

/** The parcel's status from the category on its identity field, for scans the map does not know. */
export function yanwenCategory(category: unknown): { status: CarrierStatus; stage?: Stage } | undefined {
  return typeof category === 'string' ? CATEGORY.get(category) : undefined;
}
