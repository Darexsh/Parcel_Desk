import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracker draws an order as the four steps of its scenario: a delivery
// (DEL), one left with a neighbour (NB), a swap (SW), a collection from the
// recipient (PU), a trip to the client that booked Dynalogic (RS and DP) or a
// visit that names neither a delivery nor a collection (COR). A _FAIL scenario
// ends in a step that did not happen. The labels are the tracker's English ones.
const RECEIVED = ['Received by Dynalogic', 'Sorted by Dynalogic'] as const;
const REGISTERED = ['Registered by the client', 'Processed by Dynalogic'] as const;
const STEPS: Readonly<Record<string, readonly string[]>> = {
  DEL_DEF: [...RECEIVED, 'On the way to you', 'Delivered to you'],
  DEL_NB: [...RECEIVED, 'On the way to you', 'Delivered to your neighbour'],
  DEL_FAIL: [...RECEIVED, 'On the way to you', 'Not delivered to you'],
  SW_DEF: [...RECEIVED, 'On the way to you', 'Swapped by Dynalogic'],
  SW_FAIL: [...RECEIVED, 'On the way to you', 'Not swapped by Dynalogic'],
  PU_DEF: [...REGISTERED, 'On the way to you', 'Collected by Dynalogic'],
  PU_FAIL: [...REGISTERED, 'On the way to you', 'Not collected by Dynalogic'],
  RS_DEF: [...RECEIVED, 'On the way to the client', 'Delivered to the client'],
  RS_FAIL: [...RECEIVED, 'On the way to the client', 'Not delivered to the client'],
  DP_DEF: [...RECEIVED, 'On the way to the client', 'Delivered to the client'],
  DP_FAIL: [...RECEIVED, 'On the way to the client', 'Not delivered to the client'],
  COR_DEF: [...REGISTERED, 'On the way to you', 'Completed by Dynalogic'],
  COR_FAIL: [...REGISTERED, 'On the way to you', 'Not completed by Dynalogic'],
};

const TO_YOU: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered'];
// The client is the merchant that booked the trip: a parcel that ends with it went back.
const TO_CLIENT: readonly Stage[] = ['registered', 'accepted', 'in_transit', 'in_transit', 'returned'];
const flow = (scenario: string, stages: readonly Stage[]) => stages.map((stage, step) => [`${scenario}/${step}`, stage] as const);

// A provider code is the scenario and the highest step done, 0 before the first.
// A failed scenario is staged only once its last step is done; the tracker's
// replies never showed one earlier. A collection the recipient waits for is not
// yet with Dynalogic.
const STAGES = new Map<string, Stage>([
  ...flow('DEL_DEF', TO_YOU),
  ['DEL_NB/4', 'delivered'],
  ['DEL_FAIL/4', 'failed_attempt'],
  ...flow('SW_DEF', TO_YOU),
  ['SW_FAIL/4', 'failed_attempt'],
  ...flow('PU_DEF', ['registered', 'registered', 'registered', 'registered', 'accepted']),
  ['PU_FAIL/4', 'exception'],
  ...flow('RS_DEF', TO_CLIENT),
  ['RS_FAIL/4', 'exception'],
  ...flow('DP_DEF', TO_CLIENT),
  ['DP_FAIL/4', 'exception'],
]);

const UNNAMED_VISIT = 'The COR scenario ends at the recipient\'s without naming a delivery or a collection, so what it moves is unknown.';

/** The tracker's label for the highest step done, or null before the first or for a scenario it does not draw. */
export function dynalogicStepLabel(scenario: string, reached: number): string | null {
  return STEPS[scenario]?.[reached - 1] ?? null;
}

/** The stage of a provider code, e.g. `DEL_DEF/3`. */
export function dynalogicStage(code: string): Stage | undefined {
  return STAGES.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? STAGES.get(code) : undefined),
  gaps: [0, 1, 2, 3, 4].map(step => ({ code: `COR_DEF/${step}`, note: UNNAMED_VISIT }))
    .concat({ code: 'COR_FAIL/4', note: UNNAMED_VISIT }),
};
