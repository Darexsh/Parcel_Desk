import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's scan sentences, mapped whole. The page gives no status code,
 * and its short titles group several statuses: "Automatában" is both a parcel
 * the sender dropped in a locker and one waiting in the recipient's, and
 * "Raktárban" covers a return as well as a parcel on its way. Each sentence is
 * the long text of one status of Foxpost's API. A link after the sentence is
 * not part of it. No source gives the sentences of RETURN, SLOTCHANGE,
 * OVERTIMED, MPSIN, HDINTRANSIT, WBXREDIRECT, HDHUBIN and PREREDIRECT, so a
 * scan with one keeps no stage.
 */
export const FOXPOST_SCANS: Readonly<Record<string, Stage>> = {
  // CREATE: the sender registered the parcel.
  'Csomagod létrejött a rendszerünkben, a feladó még nem adta át azt a FOXPOST részére.': 'registered',
  // C2CIN, COLLECTED and C2BIN: the sender dropped the parcel in a locker,
  // a partner handed it over, or a return was dropped in a locker.
  'Csomagod fel lett adva, a csomagautomatában el lett helyezve. A neked címzett (feladott/visszaküldött) csomagot hamarosan kézbesítjük.': 'accepted',
  'Csomagodat partnerünk átadta részünkre, már úton van a raktárunkba.': 'accepted',
  'Csomagot a feladó (eredeti csomag címzettje) visszaküldte, a csomagautomatában elhelyezte.': 'accepted',
  // OPEROUT, SORTIN in its current and earlier wording, HDSENT, HDDEPO,
  // HDHUBOUT and RESENT.
  'Csomagodat futárunk kivette a csomagautomatából.': 'in_transit',
  'Csomagod beérkezett a FOXPOST raktárába. A feladott/visszaküldött csomag hamarosan kézbesítésre kerül.': 'in_transit',
  'Csomagod beérkezett a FoxPost raktárába. A feladott/visszaküldött csomagot hamarosan kézbesítjük.': 'in_transit',
  'Csomagod beérkezett a FoxPost raktárába, hamarosan átadjuk a házhozszállítást végző partnerünknek.': 'in_transit',
  'Csomagod megérkezett a házhozszállítást végző partnerünk kiszállító depójába.': 'in_transit',
  'Csomagod a házhozszállítást végző partnerünk raktárát elhagyta. Partnerünk a csomagot hamarosan kézbesíti.': 'in_transit',
  'Az át nem vett csomagod újraküldésre került.': 'in_transit',
  // SORTOUT and HDCOURIER: on the way to the locker, or with the courier who
  // brings it to the door.
  'Csomag úton (kiszállítás/visszaszállítás alatt) van az általad választott csomagautomatához.': 'out_for_delivery',
  'Csomagod kiszállítás alatt van, a házhozszállítást végző partnerünk futára hamarosan kézbesíti.': 'out_for_delivery',
  // OPERIN: in the locker the recipient chose.
  'Csomagod megérkezett az általad választott (vissza)kézbesítési automatába, most már átveheted!': 'ready_for_pickup',
  // RECEIVE and HDRECEIVE.
  'Csomagod (vissza)kézbesítve lett, a címzett/feladó átvette.': 'delivered',
  'Csomagod házhozszállítással kézbesítve lett, a címzett átvette.': 'delivered',
  // BACKLOGINFULL and BACKLOGINFAIL: the locker is full or broken, so the
  // parcel waits to be put in.
  'Csomagodat a célautomata túltelítettsége miatt egyelőre nem tudjuk kézbesíteni, amint szabadul fel hely, csomagodat behelyezzük.': 'failed_attempt',
  'Csomagodat a célautomata műszaki hibája miatt egyelőre nem tudjuk kézbesíteni, amint a hibát javítottuk, csomagodat behelyezzük.': 'failed_attempt',
  // OVERTIMEOUT, INWAREHOUSE, BACKTOSENDER, COLLECTSENT, RETURNCOURIER,
  // RETURNDELIVERED and RETURNED: the parcel goes back to its sender.
  'Csomagod nem került átvételre a tárolási idő alatt, ezért a küldeményt visszaküldjük a feladónak.': 'returned',
  'Címzett által át nem vett / visszaküldött csomagod visszaszállításra került a FOXPOST raktárába.': 'returned',
  'Csomagot a címzett nem vette át, a csomag vissza lett küldve a feladónak.': 'returned',
  'Visszaküldött csomagod előkészítettük átadásra.': 'returned',
  'Visszaküldött csomagod a futárunknál van, hamarosan átadja üzleti partnerünk részére.': 'returned',
  'Visszaküldött csomagodat üzleti partnerünk átvette.': 'returned',
  'Átvevő által visszaküldött csomag.': 'returned',
  // MISSORT and EMPTYSLOT.
  'A csomag nem megfelelő automatára lett szortolva.': 'exception',
  'Futárunk csomag nélküli üres rekeszt talált.': 'exception',
};

/**
 * Sentences that go on with a reason or the new locker's name: the start is
 * mapped. HDUNDELIVERABLE and HDRETURN are a home delivery that failed, the
 * second with the parcel back in Foxpost's warehouse; REDIRECT sends the
 * parcel to another locker because its own is full or broken, and
 * PREPAREDFORPD has a member of staff hand it over in person instead, on the
 * date that follows.
 */
export const FOXPOST_SCAN_OPENINGS: Readonly<Record<string, Stage>> = {
  'Csomagod a házhozszállítás során nem lett átvéve, kézbesítése egyelőre sikertelen': 'failed_attempt',
  'Csomagodat a címzett a házhozszállítás során nem vette át': 'failed_attempt',
  'Csomagodat az automata telítettsége / műszaki hibája miatt átírányítottuk egy másik csomagautomatába': 'in_transit',
  'Csomagodat az automata telítettsége / műszaki hibája miatt személyesen veheted át munkatársunktól': 'ready_for_pickup',
};

const SCANS = new Map(Object.entries(FOXPOST_SCANS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const OPENINGS = Object.entries(FOXPOST_SCAN_OPENINGS).map(([wording, stage]) => [normalizeStatusWording(wording), stage] as const);

function stageOf(wording: string): Stage | undefined {
  return SCANS.get(wording) ?? OPENINGS.find(([opening]) => wording.startsWith(opening))?.[1];
}

/** The stage a scan's sentence gives it, if any. */
export function foxpostScanStage(sentence: string): Stage | undefined {
  return stageOf(normalizeStatusWording(sentence));
}

/** The tracker's scans carry a sentence and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : stageOf(wording),
  gaps: [],
};
