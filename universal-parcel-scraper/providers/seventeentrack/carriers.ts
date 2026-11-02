/**
 * 17TRACK's keys for catalog carriers, from its public carrier list
 * (`res.17track.net/asset/carrier/info/carrier.all.js`), with the name it
 * shows. Listed are carriers whose numbers 17TRACK's own detection reads as
 * another carrier's or as nobody's, and that it tracks without a postcode
 * once asked for the carrier. Ask a public number of the carrier with
 * `https://t.17track.net/en#nums={number}&fc={key}` before adding one.
 */
const CARRIER_KEYS: Readonly<Record<string, number>> = {
  'aramex': 100006, // Aramex
  'asendia': 100016, // Asendia USA: detection reads its LS…CH numbers as Swiss Post's.
  'bpost': 2061, // Bpost
  'bring-posten': 100423, // Bring
  'brt': 199997, // BRT (IT)
  'chronopost': 100273, // Chronopost
  'correos-express': 100048, // Correos Express
  'correos-spain': 19181, // Correos Spain
  'ctt-express': 100114, // CTT Express
  'dhl': 7041, // DHL Paket
  'dhl-ecommerce-pl': 100226, // DHL Parcel (PL)
  'dhl-ecommerce-uk': 100152, // DHL Parcel (UK)
  'dpd-fr': 100072, // DPD (FR)
  'dpd-pl': 100111, // DPD (PL): detection reads its numbers as DPD Germany's.
  'ecoscooting': 100435, // Ecoscooting
  'gls-fr': 101272, // GLS (FR): detection reads its numbers as GLS's group service, which shows one scan.
  'inpost': 100043, // InPost (PL)
  'intelcom': 100555, // Intelcom (CA)
  'japan-post': 10021, // Japan Post
  'korea-post': 11054, // ePOST (Domestic): its S10 numbers report as ePOST, 11051.
  'landmark-global': 100021, // Landmark Global
  'mrw': 100175, // MRW
  'nova-poshta': 100035, // Nova Poshta
  'packeta': 100132, // Packeta
  'planzer': 100734, // Planzer Parcel
  'poste-italiane': 9071, // Poste Italiane
  'purolator': 100042, // Purolator
  'relais-colis': 100461, // RelaisColis
  'ukrposhta': 21021, // Ukrposhta
  'yamato': 100062, // Yamato
};

/** Other keys the same carrier's scans report under, which need no second lookup. */
const SAME_CARRIER_KEYS: Readonly<Record<string, readonly number[]>> = {
  'korea-post': [11051],
};

/**
 * 17TRACK's keys for a catalog carrier, when asking for it can bring history
 * its detection misses: the key to ask first, then every key its scans can
 * report under.
 */
export function seventeenTrackCarrierKeys(carrier: string | null | undefined): readonly [number, ...number[]] | undefined {
  const key = carrier && Object.hasOwn(CARRIER_KEYS, carrier) ? CARRIER_KEYS[carrier] : undefined;
  if (!carrier || key === undefined) return undefined;
  return [key, ...(SAME_CARRIER_KEYS[carrier] ?? [])];
}
