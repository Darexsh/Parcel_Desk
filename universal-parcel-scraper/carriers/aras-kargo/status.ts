import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's wording, mapped whole. It gives no status codes. "Son Durum"
 * is the parcel's current status; the delivery is read from it, as the
 * movement list stops at the delivery branch.
 */
export const ARAS_STATUSES: Readonly<Record<string, Stage>> = {
  // At the branch that took the parcel in.
  'ÇIKIŞ ŞUBESİNDE': 'accepted',
  'YOLDA': 'in_transit',
  // At the branch that delivers it, also after a failed delivery.
  'TESLİMAT ŞUBESİNDE': 'in_transit',
  'TESLİM EDİLDİ': 'delivered',
};

/**
 * The vehicle movements ("Araç Hareketleri"): loading and unloading at a
 * branch ("şube") or a transfer centre ("aktarma"), and bagging there. The
 * page spells some without Turkish letters.
 */
export const ARAS_MOVEMENTS: Readonly<Record<string, Stage>> = {
  'ŞUBEDE ARAÇ YÜKLEME': 'in_transit',
  'ŞUBEDE ARAÇ İNDİRME': 'in_transit',
  'AKTARMADA HAT ARACI YÜKLEME': 'in_transit',
  'AKTARMADA HAT ARACI İNDİRME': 'in_transit',
  'AKTARMADA SUBE ARACI YUKLEME': 'in_transit',
  'AKTARMADA SUBE ARACI INDIRME': 'in_transit',
  'AKTARMADA TORBA DOLDURMA': 'in_transit',
};

/** The reasons a delivery was not made ("Teslim Edilememe Nedeni"), one row a day. */
export const ARAS_NON_DELIVERIES: Readonly<Record<string, Stage>> = {
  'TESLİMAT GÜN İÇERİSİNDE YAPILAMADI': 'failed_attempt',
  'TATİL DOLAYISIYLA TESLİMAT YAPILAMADI': 'failed_attempt',
  'UĞRAMA NOTU BIRAKILDI (1-2)': 'failed_attempt',
  'ALICI ADRESİ DAĞITIM ALANI DIŞINDA': 'failed_attempt',
};

/**
 * A redirection's state ("Kargo Durumu"). The parser adds the reason in
 * brackets, and the map reads the state without it.
 */
export const ARAS_REDIRECTIONS: Readonly<Record<string, Stage>> = {
  'YÖNLENDİRİLDİ': 'in_transit',
};

/** A redirection's reason, which the parser adds in brackets. */
const REASON = /\s*\([^()]*\)$/;

const WORDINGS = new Map(Object.entries({ ...ARAS_STATUSES, ...ARAS_MOVEMENTS, ...ARAS_NON_DELIVERIES })
  .map(([wording, stage]) => [normalizeStatusWording(wording), stage]));
const REDIRECTIONS = new Map(Object.entries(ARAS_REDIRECTIONS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

function stageOf(wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? REDIRECTIONS.get(wording.replace(REASON, ''));
}

/** The stage the tracker's wording gives a status or a scan, if any. */
export function arasStage(wording: string): Stage | undefined {
  return stageOf(normalizeStatusWording(wording));
}

/** The tracker's scans carry wording and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : stageOf(wording),
  gaps: [],
};
