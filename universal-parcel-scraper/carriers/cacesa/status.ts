import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

// Each milestone has a type and an icon. The tracker shows the type as its
// state: `EVENTO` "In transit", `ENTREGADO` "Delivered", `INCIDENCIA`
// "Incident" and `ERROR` "Error". The icon names the milestone; two milestones
// share the warehouse icon, both in transit.
const EVENTS: Readonly<Record<string, Stage>> = {
  // The parcel's data reached CACESA before the parcel did.
  ico_notification: 'registered',
  ico_almacen: 'in_transit',
  ico_recepcionalmacen: 'in_transit',
  ico_aduana: 'customs',
  // The recipient uploaded the document customs asked for.
  ico_subirdocu: 'customs',
  // Customs released the parcel.
  ico_okaduana: 'in_transit',
};

// Incidents CACESA names by icon: customs holding the parcel for inspection,
// or for the documents it checks ("ko" beside the customs icon).
const INCIDENTS: Readonly<Record<string, Stage>> = {
  ico_aduana: 'exception',
  ico_aduanako: 'exception',
};

/** The provider code of a milestone: its type, a slash and its icon ("EVENTO/ico_aduana"). */
export function cacesaCode(type: string, icon: string): string {
  return `${type}/${icon}`;
}

/**
 * A milestone's stage from its type and icon. A delivered milestone is
 * delivered whatever its icon. Errors, and incidents and icons no reply
 * showed, are left to the shared wording rules.
 */
export function cacesaStage(type: string, icon: string): Stage | undefined {
  if (type === 'ENTREGADO') return 'delivered';
  const stages = type === 'EVENTO' ? EVENTS : type === 'INCIDENCIA' ? INCIDENTS : null;
  return stages && Object.hasOwn(stages, icon) ? stages[icon] : undefined;
}

/** What the map says about one milestone, by its provider code alone. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => {
    const [type, icon, ...rest] = (code ?? '').split('/');
    return type && icon && !rest.length ? cacesaStage(type, icon) : undefined;
  },
  gaps: [],
};
