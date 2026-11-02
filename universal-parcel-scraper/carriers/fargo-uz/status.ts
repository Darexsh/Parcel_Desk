import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The status codes of Fargo's tracker, as its page's script names and groups
 * them. The page's progress rail puts every code before collection on its
 * first step, so acceptance and pickup bookings stay registered. A delivery
 * attempt is logged with each try, successful or not: its outcome is the code
 * beside it, a delivery or a reason the courier gave for not delivering.
 */
const CODES: ReadonlyMap<string, Stage> = new Map([
  ['created', 'registered'],
  ['unassigned', 'registered'],
  ['pending_assign_to_courier', 'registered'],
  ['collection_arranged_or_requested', 'registered'],
  ['future_pickup_requested', 'registered'],
  ['accepted', 'registered'],
  ['pickup_confirmed', 'registered'],
  // A courier on the way to the sender, there, or trying to collect the parcel.
  ['on_his_way', 'registered'],
  ['ready_for_pickup', 'registered'],
  ['arrived', 'registered'],
  ['pick_up_attempt', 'registered'],
  ['first_pickup_attempt', 'registered'],
  ['second_pickup_attempt', 'registered'],
  ['third_pickup_attempt', 'registered'],
  ['other_pickup_attempt', 'registered'],
  ['picked_up', 'accepted'],
  ['picked_up_auto', 'accepted'],
  ['dispatched', 'in_transit'],
  ['in_sorting_facility', 'in_transit'],
  ['partially_in_sorting_facility', 'in_transit'],
  ['in_different_warehouse', 'in_transit'],
  ['prepared_for_transit', 'in_transit'],
  ['in_transit', 'in_transit'],
  // Handed on to a partner carrier.
  ['in_transit_to_supplier', 'in_transit'],
  ['transited_to_supplier', 'in_transit'],
  ['arrived_at_border', 'in_transit'],
  ['clearing_customs', 'customs'],
  ['detained_by_customs', 'customs'],
  ['customs_hold', 'customs'],
  ['released_by_customs', 'in_transit'],
  ['out_for_delivery', 'out_for_delivery'],
  ['arrived_to_delivery_address', 'out_for_delivery'],
  ['delivery_attempt', 'out_for_delivery'],
  ['first_delivery_attempt', 'out_for_delivery'],
  ['second_delivery_attempt', 'out_for_delivery'],
  ['third_delivery_attempt', 'out_for_delivery'],
  ['other_delivery_attempt', 'out_for_delivery'],
  ['ready_for_issue', 'ready_for_pickup'],
  ['delivered_to_locker', 'ready_for_pickup'],
  ['completed', 'delivered'],
  ['issued', 'delivered'],
  ['partial_complete', 'delivered'],
  // The reasons a courier gives for a delivery that did not happen; the parcel can go out again.
  ['delivery_failed', 'failed_attempt'],
  ['recipient_not_available', 'failed_attempt'],
  ['recipient_mobile_switched_off', 'failed_attempt'],
  ['recipient_mobile_wrong', 'failed_attempt'],
  ['recipient_mobile_no_response', 'failed_attempt'],
  ['recipient_address_change_requested', 'failed_attempt'],
  ['recipient_name_missing', 'failed_attempt'],
  ['unable_to_access_recipient_premises', 'failed_attempt'],
  ['delivery_delay_due_to_late_booking', 'failed_attempt'],
  ['no_time_for_delivery', 'failed_attempt'],
  ['no_capacity', 'failed_attempt'],
  ['no_capacity_for_delivery', 'failed_attempt'],
  ['bad_weather_during_delivery', 'failed_attempt'],
  ['cod_not_ready', 'failed_attempt'],
  ['recipient_wants_inspect_item', 'failed_attempt'],
  ['id_or_document_required_missing', 'failed_attempt'],
  ['all_failed', 'exception'],
  ['delivery_rejected', 'exception'],
  ['bad_recipient_address', 'exception'],
  ['out_of_delivery_area', 'exception'],
  ['wrong_shipment', 'exception'],
  ['incomplete_parcel', 'exception'],
  ['incorrect_packing', 'exception'],
  ['prohibited_items', 'exception'],
  ['mis_routed', 'exception'],
  ['on_hold', 'exception'],
  ['check_address', 'exception'],
  ['lost', 'exception'],
  ['damaged', 'exception'],
  ['lost_or_damaged', 'exception'],
  ['lost_or_damaged_closed', 'exception'],
  ['cancelled', 'exception'],
  ['destroyed_on_customer_request', 'exception'],
  ['duty_declined', 'exception'],
  ['driver_cancelled', 'exception'],
  ['rejected_by_customs', 'exception'],
  ['cancelled_due_to_out_of_delivery_area', 'exception'],
  // On the way back to the sender, or to the platform's own return point (Wing).
  ['to_be_returned', 'returned'],
  ['out_for_return', 'returned'],
  ['dispatch_for_return', 'returned'],
  ['returning_to_origin', 'returned'],
  ['returned_to_origin', 'returned'],
  ['returned_by_customs', 'returned'],
  ['to_be_returned_to_wing', 'returned'],
  ['returning_to_wing', 'returned'],
  ['returned_to_wing', 'returned'],
]);

const PICKUP_PROBLEM = 'A problem collecting the parcel from the sender; the parcel has not moved.';

/** Codes that move nothing, each with the reason. */
const GAPS: ReadonlyMap<string, string> = new Map([
  ['update', 'A bare update the page itself passes over for the current status; it moves nothing.'],
  ['assigned_to_courier', 'A courier assigned to the order, for collection or delivery; it moves nothing.'],
  ['driver_unassigned', 'A courier taken off the order; the parcel stays where it was.'],
  ['driver_rejected', 'A courier declined the order; the parcel stays where it was.'],
  ['delivery_scheduled', 'A delivery planned for later, which is no scan.'],
  ['future_delivery_requested', 'A delivery asked for later, which is no scan.'],
  ['cod_transferred', 'The cash collected on delivery passed on to the shop after the delivery; it moves nothing.'],
  ['overdue', 'A flag that the order is late; it moves nothing.'],
  ['office_closed', 'An office found closed, at collection or delivery; the scan does not say which.'],
  ['other_reason', 'A reason without detail, given at collection or delivery; the scan beside it says what happened.'],
  ['pick_up_failed', PICKUP_PROBLEM],
  ['pickup_rejected', PICKUP_PROBLEM],
  ['pickup_on_hold', PICKUP_PROBLEM],
  ['bad_sender_address', PICKUP_PROBLEM],
  ['sender_not_available', PICKUP_PROBLEM],
  ['parcel_not_ready', PICKUP_PROBLEM],
  ['sender_mobile_switched_off', PICKUP_PROBLEM],
  ['sender_mobile_wrong', PICKUP_PROBLEM],
  ['sender_mobile_no_response', PICKUP_PROBLEM],
  ['sender_address_change_requested', PICKUP_PROBLEM],
  ['sender_name_missing', PICKUP_PROBLEM],
  ['out_of_pickup_area', PICKUP_PROBLEM],
  ['unable_to_access_sender_premises', PICKUP_PROBLEM],
  ['pickup_delay_due_to_late_booking', PICKUP_PROBLEM],
  ['bad_weather_during_pickup', PICKUP_PROBLEM],
  ['no_awb_printed', PICKUP_PROBLEM],
]);

/** The stage Fargo's code gives a scan. */
export function fargoUzMappedStage(code: string): Stage | undefined {
  return CODES.get(code);
}

/** A scan's stage: its code, else nothing for a code that moves nothing, else the shared wording rules. */
export function fargoUzStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = fargoUzMappedStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (GAPS.has(code)) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? fargoUzMappedStage(code) : undefined),
  gaps: [...GAPS].map(([code, note]) => ({ code, note })),
};
