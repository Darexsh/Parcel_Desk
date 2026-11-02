/**
 * Ship24's courier codes for catalog carriers, from its public courier list
 * (`api.ship24.com/backoffice/api/v1/master-couriers`), with the name it
 * shows. Listed are carriers whose numbers Ship24 answers HTTP 404 for until
 * the visitor names the courier, as the tracking page's "Add details" dialog
 * does, and then tracks, or says it keeps the courier for subscribers. Ask a
 * public number of the carrier with `to_check` set to the code (see http.ts)
 * before adding one.
 */
const COURIER_CODES: Readonly<Record<string, string>> = {
  'aliexpress': 'cainiao', // Cainiao
  'allegro-one': 'allegro', // Allegro
  'asendia': 'asendia', // Asendia
  'brt': 'brt-it', // BRT Italy (DPD Group)
  'ciblex': 'ciblex', // Ciblex Express
  'colis-prive': 'colis-prive', // Colis Prive
  'ctt-express': 'tourline-express', // CTT Express (Tourline Express)
  'delhivery': 'delhivery', // Delhivery
  'dhl-ecommerce': 'dhl-global-mail', // DHL eCommerce Global
  'dhl-ecommerce-pl': 'dhl-pl', // DHL Poland
  'dpd-pl': 'dpd-pl', // DPD Poland
  'dpd-ro': 'dpd-ro', // DPD Romania
  'four-px': '4px', // 4PX
  'globalpost': 'global-post', // Global Post
  'imile': 'imile', // iMile
  'mailamericas': 'mailamericas', // MailAmericas
  'mainfreight': 'mainfreight', // Mainfreight
  'mondial-relay': 'mondialrelay', // Mondial Relay
  'nova-poshta': 'nova-poshta', // Nova Poshta
  'packeta': 'packeta', // Packeta
  'ppl': 'ppl-cz', // PPL CZ (Professional Parcel Logistic)
  'royal-mail': 'gb-post', // Royal Mail: for subscribers only
  'sf-express': 'sf-express', // SF Express (Shunfeng): for subscribers only
  'shiprocket': 'shiprocket', // Shiprocket
  'tnt': 'tnt', // TNT: the answer takes up to ten seconds
  'ups': 'ups', // UPS: for subscribers only
};

/** Ship24's courier code for a catalog carrier, when naming it can bring a parcel Ship24 answers 404 for. */
export function ship24CourierCode(carrier: string | null | undefined): string | undefined {
  return carrier && Object.hasOwn(COURIER_CODES, carrier) ? COURIER_CODES[carrier] : undefined;
}
