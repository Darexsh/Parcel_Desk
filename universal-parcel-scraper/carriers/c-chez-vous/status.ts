/**
 * C Chez Vous order steps.
 *
 * The tracking page is a progress bar, and the JSON it embeds reports that step
 * per parcel as `parcelStep`. There is no wording and no scan history: the step
 * is the whole status vocabulary. The page's script titles and explains each
 * step, and the French descriptions below follow those explanations.
 *
 * A home delivery has five steps. Its fourth, titled "En livraison", is the
 * trip to the regional platform before the booked appointment, not the
 * delivery round. An order for a pickup point (`delivery_type` "EMP") books no
 * appointment and has six: the parcel waits at the point on step 5 and is
 * collected on step 6.
 *
 * A step its order's set does not list is a step this map does not know. It is
 * reported as `UNKNOWN_STEP` rather than clamped to a documented step, so the
 * sync classifies it and records it for review instead of us claiming an order
 * has not started.
 */
import type { CarrierStatus } from '../../core/result/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import type { Stage } from '../../generated/catalog.js';

export interface StepDetails {
  status: CarrierStatus;
  stage: Stage;
  description: string;
}

export type DeliveryKind = 'home' | 'pickup';

/** Sorts below every documented step, so an unknown parcel makes the order unknown. */
export const UNKNOWN_STEP = 0;

export const UNKNOWN_STEP_DESCRIPTION = 'Suivi C Chez Vous';

export const STEP_DETAILS: Record<DeliveryKind, Readonly<Record<number, StepDetails>>> = {
  home: {
    1: { status: 'pending', stage: 'registered', description: 'Commande enregistrée' },
    2: { status: 'pending', stage: 'registered', description: 'Prise de rendez-vous' },
    3: { status: 'in_transit', stage: 'in_transit', description: 'Commande en préparation' },
    4: { status: 'in_transit', stage: 'in_transit', description: 'Commande en route vers la plateforme régionale' },
    5: { status: 'delivered', stage: 'delivered', description: 'Commande livrée' },
  },
  pickup: {
    1: { status: 'pending', stage: 'registered', description: 'Commande enregistrée' },
    3: { status: 'in_transit', stage: 'in_transit', description: 'Commande en préparation' },
    4: { status: 'in_transit', stage: 'in_transit', description: 'Commande en route vers le point retrait' },
    5: { status: 'out_for_delivery', stage: 'ready_for_pickup', description: 'Commande disponible au point retrait' },
    6: { status: 'delivered', stage: 'delivered', description: 'Commande retirée au point retrait' },
  },
};

/** The order's step set: a pickup-point order's, or a home delivery's. */
export function deliveryKind(deliveryType: unknown): DeliveryKind {
  return deliveryType === 'EMP' ? 'pickup' : 'home';
}

/** The documented step of one parcel, or `UNKNOWN_STEP` when its order's set does not list it. */
export function parcelStep(value: unknown, kind: DeliveryKind = 'home'): number {
  return typeof value === 'number' && Object.hasOwn(STEP_DETAILS[kind], value) ? value : UNKNOWN_STEP;
}

export function stepDetails(step: number, kind: DeliveryKind = 'home'): StepDetails | null {
  return Object.hasOwn(STEP_DETAILS[kind], step) ? STEP_DETAILS[kind][step]! : null;
}

/** The stage of each step's wording, left out where two steps word it alike with different stages. */
const STAGE_BY_WORDING = new Map<string, Stage | undefined>();
for (const { description, stage } of Object.values(STEP_DETAILS).flatMap((steps) => Object.values(steps))) {
  const key = normalizeStatusWording(description);
  STAGE_BY_WORDING.set(key, STAGE_BY_WORDING.has(key) && STAGE_BY_WORDING.get(key) !== stage ? undefined : stage);
}

/**
 * What the map says about the order's one event: the wording of its step, as the adapter writes
 * it. An unknown step's wording stays open, since the stored event does not keep the step.
 */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => STAGE_BY_WORDING.get(wording), gaps: [] };
