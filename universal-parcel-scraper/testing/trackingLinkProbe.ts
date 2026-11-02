/** A public tracking page check is distinct from a successful parcel lookup. */
export interface TrackingPageSnapshot {
  status: number;
  url: string;
  title: string;
  text: string;
}

export type TrackingPageVerdict = 'tracking-page' | 'blocked' | 'broken' | 'unverified';

// Amazon's storefront bot check answers 200 in place of the requested page,
// with a button or, in its older form, an image to read. LogoiX answers
// datacenter networks on its tracker's address with a reCAPTCHA checkbox.
const CHALLENGE = /just a moment|un instant|access denied|attention required|verify you are human|vérification de sécurité|complete the captcha|captcha required|checking your browser|click the button below to continue shopping|enter the characters you see below|dass sie kein bot sind/i;
const MISSING_PAGE = /page (?:not found|does not exist|cannot be found)|404 (?:error|not found)|seite nicht gefunden|page introuvable|pagina non trovata/i;

export function trackingPageVerdict(
  page: TrackingPageSnapshot,
  route: RegExp,
  trackingContent: RegExp,
  shipmentNotFound?: { status: 404 | 410; marker: RegExp },
): TrackingPageVerdict {
  // A generic homepage, error route or missing page must never pass merely
  // because the carrier returned 200. Shipment-not-found is a valid tracker.
  const knownAbsence = shipmentNotFound?.status === page.status && route.test(page.url)
    && shipmentNotFound.marker.test(page.text);
  if (((page.status === 404 || page.status === 410) && !knownAbsence) || page.status >= 500) return 'broken';
  const content = page.title + '\n' + page.text;
  if ([401, 403, 429].includes(page.status)
    || CHALLENGE.test(content)) return 'blocked';
  if ((!knownAbsence && (page.status < 200 || page.status >= 300)) || !route.test(page.url)) return 'broken';
  if (MISSING_PAGE.test(content)) return 'broken';
  return trackingContent.test(page.text) ? 'tracking-page' : 'unverified';
}

export type SearchPageVerdict = 'search-page' | 'blocked' | 'unverified' | 'broken';

/**
 * A carrier's search page, opened with no number, works when it shows a field
 * to type one in. A challenge, or a document with no title and no text, leaves
 * it unverified; a missing page, an error page or a page with no field is broken.
 */
export function searchPageVerdict(page: TrackingPageSnapshot, numberFields: number): SearchPageVerdict {
  if (page.status === 404 || page.status === 410 || page.status >= 500) return 'broken';
  const content = page.title + '\n' + page.text;
  if (numberFields > 0 && page.status >= 200 && page.status < 300 && !MISSING_PAGE.test(content)) return 'search-page';
  if ([401, 403, 412, 429].includes(page.status) || CHALLENGE.test(content)) return 'blocked';
  // Bot walls answer automated phones with an empty document; a carrier page has a title.
  if (!page.title.trim() && !page.text.trim()) return 'unverified';
  return 'broken';
}
