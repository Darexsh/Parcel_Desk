import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

interface Labelled { readonly stage: Stage; readonly label: string }

/**
 * Anousith's `itemStatus` codes with the label its tracking page gives each.
 * A parcel waits at its destination branch for the recipient, who collects
 * it there unless they pay for a rider to bring it.
 */
const ITEM_STATES: ReadonlyMap<string, Labelled> = new Map([
  ['CREATING', { stage: 'registered', label: 'ພັດສະດຸສ້າງໃຫມ່' }],
  ['REQUESTED', { stage: 'registered', label: 'ລໍຖ້າສາຂາ(ຕົ້ນທາງ)ກົດຮັບ' }],
  ['CONFIRM_BY_SHIPPER', { stage: 'registered', label: 'ຢືນຢັນລົງສາຂາ' }],
  ['ADD_SHIPPER', { stage: 'registered', label: 'ໄລເດີ່ກຳລັງອອກໄປຮັບ' }],
  ['RIDER_APPROVED', { stage: 'accepted', label: 'ໄຮເດີຮັບເຄື່ອງແລ້ວ' }],
  ['ORIGIN_BRANCH_RECEIVED', { stage: 'accepted', label: 'ສາຂາຕົ້ນທາງຮັບແລ້ວ' }],
  ['ORIGIN_BRANCH_RECEIVED_FORWARD', { stage: 'accepted', label: 'ສາຂາຕົ້ນທາງຮັບພັດສະດຸແລ້ວ' }],
  ['TRANSIT_TO_DEST_BRANCH', { stage: 'in_transit', label: 'ກຳລັງຂົນສົ່ງໄປປາຍທາງ' }],
  ['TRANSIT_TO_OFFICE', { stage: 'in_transit', label: 'ພັດສະດຸໄປສຳນັກງານໃຫຍ່' }],
  ['DEST_BRANCH_RECEIVED_FORWARD', { stage: 'ready_for_pickup', label: 'ຮອດສາຂາປາຍທາງເເລ້ວ' }],
  // At the destination branch, with a rider's delivery asked for and not yet started.
  ['DELIVER_TO_THE_ADDRESS', { stage: 'in_transit', label: 'ຮອດປາຍທາງ' }],
  ['RECEIVING_ORDERS', { stage: 'out_for_delivery', label: 'ໄລເດີ້ກຳລັງຈັດສົ່ງ...' }],
  // The rider brought it back to the branch.
  ['IS_BACKWARD_FOR_CUSTOMER', { stage: 'failed_attempt', label: 'ພັດສະດຸສົ່ງເຖິງທີ່ຖືກຕີກັບ' }],
  ['COMPLETED', { stage: 'delivered', label: 'ພັດສະດຸສົ່ງສຳເລັດ' }],
  ['TRANSIT_TO_ORIGIN_BRANCH', { stage: 'returned', label: 'ກຳລັງຕີກັບສາຂາຕົ້ນທາງ' }],
  ['ORIGIN_BRANCH_RECEIVED_BACKWARD', { stage: 'returned', label: 'ຕີກັບຮອດສາຂາຕົ້ນທາງແລ້ວ' }],
  ['LOST', { stage: 'exception', label: 'ພັດສະດຸເສຍຫາຍ' }],
  ['LOCKED', { stage: 'exception', label: 'ພັດສະດຸລ໋ອກສາຍ' }],
  ['RECEIVED_CONFISCATED', { stage: 'exception', label: 'ພັດສະດຸຖຶກຍືດ' }],
  ['RECEIVED_LAWLESS', { stage: 'exception', label: 'ພັດສະດຸຜິດກົດໝາຍ' }],
  ['CANCELED', { stage: 'exception', label: 'ຍົກເລິກແລ້ວ' }],
  ['CANCEL_BY_ADMIN', { stage: 'exception', label: 'ຖືກຍົກເລິກ' }],
]);

/** The page's label for a parcel its sender got back, which shares the delivery's code. */
export const RETURN_COMPLETED = 'ສົ່ງຄືນແມ່ຄ້າສຳເລັດແລ້ວ';

/** The stage and label of a bill's `itemStatus`; a completed return is back with the sender. */
export function itemState(code: string, backward: boolean): Labelled | undefined {
  if (code === 'COMPLETED' && backward) return { stage: 'returned', label: RETURN_COMPLETED };
  return ITEM_STATES.get(code);
}

/**
 * The bill's own dates, under the labels the tracking page's timeline gives
 * them, in the order the parcel reaches them.
 */
export const MILESTONES = {
  createdDate: { stage: 'registered', label: 'ລໍຖ້າສາຂາຮັບເຄື່ອງ' },
  originReceiveDate: { stage: 'accepted', label: 'ຢູ່ສາຂາຕົ້ນທາງ' },
  originSendDate: { stage: 'in_transit', label: 'ກຳລັງຍ້າຍໄປສາຂາປາຍທາງ' },
  destReceiveDate: { stage: 'ready_for_pickup', label: 'ຮອດສາຂາປາຍທາງແລ້ວ' },
  sendCompleteDate: { stage: 'delivered', label: 'ຈັດສົ່ງສຳເລັດແລ້ວ' },
  destSendDate: { stage: 'returned', label: 'ກຳລັງຍ້າຍໄປສາຂາຕົ້ນທາງ (ເຄື່ອງຕີກັບ)' },
  receiveBackwardDate: { stage: 'returned', label: 'ຮອດສາຂາຕົ້ນທາງແລ້ວ' },
} as const satisfies Record<string, Labelled>;

/** The mark the page puts after a scan of a parcel on its way back. */
export const RETURN_MARK = '(ເຄື່ອງຕີກັບ)';

const SCANS: ReadonlyMap<string, Labelled> = new Map([
  ['SCAN_IN', { stage: 'in_transit', label: 'ສະແກນເຂົ້າ' }],
  ['SCAN_OUT', { stage: 'in_transit', label: 'ສະແກນອອກ' }],
  ['COMPLETED', { stage: 'delivered', label: 'ສົ່ງສຳເລັດ' }],
]);

/** A scan's wording and stage by its `scanStatus`; a scan on the way back is part of the return. */
export function scanState(code: string, backward: boolean): Labelled | undefined {
  const scan = SCANS.get(code);
  if (!scan || !backward) return scan;
  return { stage: 'returned', label: `${scan.label} ${RETURN_MARK}` };
}

const WITHOUT_CODE: ReadonlyMap<string, Stage> = new Map([
  ...Object.values(MILESTONES).map(({ label, stage }) => [normalizeStatusWording(label), stage] as const),
  [normalizeStatusWording(RETURN_COMPLETED), 'returned'],
]);

const SCAN_WORDINGS: ReadonlyMap<string, Stage> = new Map([...SCANS.keys()].flatMap((code) => [false, true].map((backward) => {
  const scan = scanState(code, backward)!;
  return [JSON.stringify([code, normalizeStatusWording(scan.label)]), scan.stage] as const;
})));

/**
 * What the map says about one scan. A scan's code and its wording tell its
 * direction; a code without a wording the map knows is read as a bill's code,
 * which for a completion leaves the direction to the wording too. The bill's
 * dates come without a code.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => {
    if (code === null) return WITHOUT_CODE.get(wording);
    const scan = SCAN_WORDINGS.get(JSON.stringify([code, wording]));
    if (scan) return scan;
    if (code === 'COMPLETED') {
      if (wording === normalizeStatusWording(RETURN_COMPLETED)) return 'returned';
      return wording === normalizeStatusWording(ITEM_STATES.get(code)!.label) ? 'delivered' : undefined;
    }
    return ITEM_STATES.get(code)?.stage;
  },
  gaps: [
    { code: 'DUPLICATE', note: 'A bill entered twice. It says nothing about where the parcel is.' },
  ],
};
