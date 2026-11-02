# DHL

DHL Paket and German tracked mail, through the public recipient endpoint behind
`www.dhl.de`. DHL eCommerce is [dhl-ecommerce](../dhl-ecommerce/README.md);
numbers of other DHL divisions are rejected by this endpoint and reported as
such.

## How it works

1. `direct`: `GET /int-verfolgen/data/config` opens a cookie and CSRF session,
   then `GET /int-verfolgen/data/search?piececode=…` is sent with the
   `verfolgen-CSRF-token` and `verfolgen-wg` headers DHL's own page sends, and
   `language=de` for a lookup whose `language` is German, `language=en` for any
   other. DHL words its scans in German or English and answers any other
   language in German. The token rotates through a response header. The session is kept in memory and
   replaced after 100 minutes. A rejected session (redirect, 401/403/419, or a
   non-JSON body) or an interrupted read gets one fresh session inside this
   step; a fresh session rejected outright goes straight to `trawl`.
2. `trawl`: only when a browser service is configured, and only after a
   rejected session or a network failure. The service solves the tracking page
   (`skipHttp`, up to tier 3); its cookies and user agent seed a new HTTP
   session, which is kept for later lookups.

Lookups are serialised per instance, so two parcels never renew the session at
once.

When DHL holds several shipments under the number, the record asks for the
recipient's postcode (`plzBenoetigt`). Given one, the adapter sends it as DHL's
page does: a JSON `POST /int-verfolgen/data/shipment` with the number, the
postcode and the record's `international` flag, which answers like `search`. It
asks for English whatever the lookup's language, because a refused postcode is
read by its English wording. It
sends nothing when the record asks for the sender's postcode (`isShipperPlz`) or
the shipping date, or names no shipment. The catalog offers the postcode,
optional, for twelve-digit numbers: recognition asks DHL about those, so it is
how a consumer learns that DHL holds one behind a postcode.

## Notes

- `JVGL` numbers belong to [DHL eCommerce Netherlands](../dhl-ecommerce-nl/README.md):
  this endpoint answers them as another DHL service.
- `JD01` piece identifiers belong to [DHL Express](../dhl-express/README.md):
  this endpoint answers them as another DHL service too. Typed with the
  label's `(J)`, as `JJD0146`, they go to DHL Express as well: this endpoint
  then shows only the last-mile scans DHL Paket adds when it delivers the piece.
- `JJD` licence plates are shared by DHL's European parcel networks and detected
  as DHL Paket. The adapter of another network, such as
  [Poland's](../dhl-ecommerce-pl/README.md), reads one when its carrier is named.
  A plate of `JJD` and sixteen digits is the length Yodel, now InPost's UK
  network, prints, so it only suggests DHL after [InPost](../inpost/README.md).
- A plate typed without its `(J)`, as `JD` and eighteen digits outside the
  `JD01` range, is still DHL Paket's: DHL's global tracking lists that form as
  the piece of a DHL Paket shipment. It only suggests DHL, because this
  endpoint's answer for that form is unconfirmed.
- `R`, a letter, nine digits and `DE` are Deutsche Post registered letters,
  national and international. This endpoint answers them from Deutsche Post's
  letter tracking, the lookup deutschepost.de embeds as well, so they are DHL's
  when their S10 check digit holds rather than international mail. A letter
  without scans yet comes back with `briefNichtGefunden` and reads as no data.
- `U`, a letter, nine digits and `DE` are Deutsche Post items without customer
  tracking, such as Warenpost International without tracking, whose barcode
  only sorts them ([Paketda](https://www.paketda.de/ausland/warenpost-international.php)).
  Deutsche Post does not scan them, so this endpoint answers them with no data,
  but they are DHL's when their S10 check digit holds: a parcel filed under DHL
  can then ask the post of the country it is looked up from. `UU` stays
  international mail, because Deutsche Post's offices abroad, DHL eCommerce's
  among them, issue it too.
- A Frankier-ID is the twenty-character identity of a letter franked with Deutsche
  Post's machine-readable postage, such as a stamp with a Matrixcode, and the
  number its basic letter tracking takes. It shows at most two letter-centre scans.
  Its last character is a CRC-4 check over the other nineteen, as the
  [DV-Freimachung specification](https://www.deutschepost.de/dam/jcr:41a5bcd7-24e1-4752-94da-2e6c1f934aea/dp-datamatrixcode-dv-freimachung_1.5.4.pdf)
  (6.2) defines it. This endpoint answers them, so an ID of `A0` and eighteen
  hexadecimal characters whose check holds is DHL's; no other carrier issues the
  shape. Other order marks are not claimed.
- `0034043…` numbers are SSCCs. DHL Paket issues its own under GS1 company
  prefixes from `4043383` up, where its numbers fall. Manufacturers hold
  prefixes below and among them for their own SSCCs. A number under a prefix
  with a known manufacturer, or below `4043383`, only suggests DHL, as does a
  failing GS1 check digit. No DHL rule claims `4043366`, a wholesaler's prefix
  seen on DB Schenker road shipments.
- Twelve-digit parcel numbers are Identcodes, closed by Deutsche Post's check
  digit (weights 4 and 9 from the left, mod 10). FedEx, Japan Post, Sagawa and
  others also use twelve digits, so a passing check only adds DHL to the
  suggestions. Recognition asks DHL about these through the direct session alone: DHL's
  explicit no-data answer is unknown, and a rejected session stays inconclusive rather than
  opening the browser. Recognition does not ask DHL about the other numbers it only suggests.
- Sessions are replaced at 100 minutes because DHL's edge stops answering a
  session about two hours old instead of rejecting it. Without the cap, the
  lookup that crosses that age waits out the 15-second timeout before renewing.
- Renewal stays inside `direct` rather than being its own step, so routine
  renewals don't show up as fallbacks in monitoring.
- Rate limits, server errors and payloads that don't match the requested number
  end the lookup. A browser would only hide a provider problem.
- DHL answers unknown numbers with explicit `sendungNichtGefunden` flags. An
  empty or unmatched `sendungen` array is a schema error, not "no data yet".
- The endpoint has no status codes: stages come from English or German wording,
  and the `istZugestellt` / `ruecksendung` flags outrank it. The German wording
  is DHL's own, not a translation of the English: a parcel being prepared for
  the delivery vehicle, "processed in the delivery base" in English, is in
  transit in both. Times are the same in both languages, and places are
  countries named in the lookup's language.
- A scan stored in one language takes the other's wording in place: at its
  instant, the same stage and the same place, a country in either language,
  identify it. Where DHL dates several such scans at one instant, as on a
  parcel's arrival abroad, what they say tells them apart
  ([identity.ts](identity.ts)).
- A forecast ("will be delivered tomorrow", "wird … zugestellt") keeps the
  progress fallback. Mapping it to `delivered` would announce a delivery that
  hasn't happened; mapping it to `registered` would undo real progress.
- "Delivery not possible" is a failed attempt: it follows the loading onto the
  delivery vehicle, the parcel then waits at a retail outlet, and the partner
  posts' copies of the scan read it so.
- `fortschritt` is only the fallback for unmapped wording (`<= 1` means the
  parcel is still announced); the wording explains progress better.
- Timestamps carry an offset and are kept verbatim, except on scans DHL places
  in another country, its own or a partner post's. Those show that country's
  wall clock under Germany's offset, as the partners' copies of the same scans
  show, so they keep the wall clock alone and the country's zone dates them
  (`tracking.localClocks`). An offset other than Germany's stays as stated.
  The delivery window is a calendar day.
- A single unambiguous link to a known carrier portal in an arrival event (such
  as Swiss Post) becomes `delivery_carrier`; the host confirms the shipment
  through that carrier before switching. Lookalike hosts and userinfo URLs are
  ignored. The notice is then shown without the link, which DHL appends as
  `(Homepage / online shipment tracking: …)`, at times empty; a notice stored with
  it keeps its row. DHL Express's
  tracking page names DHL Express, which tracks its own
  waybills only, so it is not asked about DHL's number; DHL's tracker keeps the
  Express scans to the delivery.
- Without such a link, a `C` postal number, DHL Paket's international parcel,
  is proposed to the partner DHL's
  [country pages](https://www.dhl.de/de/privatkunden/pakete-versenden/weltweit-versenden/land/polen.html)
  name, which is not always the destination's post: PostNord in Finland and
  Meest in Ukraine. DHL Express in Poland and Switzerland and Itella in
  Lithuania and Latvia do not look up DHL's number, so no one is asked there
  until the arrival scan links the partner. Nor is anyone asked for Spain and
  Italy, where the pages name Correos and SDA but DHL's arrival scans link DHL
  Parcel Spain and DHL Express, and Correos does not know the parcels.
  Deutsche Post's letter-post items go to the destination's post.
- `zielland`, the destination country DHL names in the lookup's language, becomes
  `destination_country`, or `destination_country_name` when the name maps to no
  ISO code. Nothing else of the delivery address is read.
- Links to dhl.com name DHL, except DHL's division pages and DHL eCommerce's
  regional pages: the network they mean depends on the country, so they name
  none.
- Not used: Deutsche Post's business tracking API — needs contractual
  credentials for data the recipient page exposes publicly.
- Not used: the Post & DHL app (`de.dhl.paket`). Its tracking tab is a web view
  of the same page, calling the same `/int-verfolgen/data` endpoints behind the
  same protection. Its native API clients serve signed-in accounts only.

## Limitations

- Shipments that need a postcode or shipping date on DHL's site, and numbers
  belonging to another DHL service, are explicit errors, not "not yet
  announced". A postcode request on a record with no "not found" flag carries the
  reason `parcel_found`: DHL holds the parcel, so recognition counts the number as
  known. A postcode DHL refuses ("Your input was incorrect", or an answer still
  asking for it) carries the reason `postcode_mismatch`. After repeated refusals
  DHL names the time it takes another, which becomes the error's retry delay.
  Another refusal stays an HTTP error. When DHL Paket says it holds no Paket
  shipment under the number, the inconclusive error carries the reason
  `portal_not_found`, so a consumer can tell DHL's answer from an outage.
- DHL's global tracking page answers DHL Paket numbers too: its `utapi` reply
  names the shipment's service `parcel-de` and lists the same scans as this
  endpoint, with the places this endpoint shows only for the recipient's
  postcode. It needs the browser verification the
  [DHL Express](../dhl-express/README.md) helper completes, and that helper
  takes Express numbers only. Whether it answers a record this endpoint holds
  behind the recipient's postcode is untested, so the adapter does not ask it.
- No weight, dimensions, sender or pickup-point data is read.
- Recipient name, address (beyond its country), signature and service details
  are never read; a test asserts it.

## Testing

`npm run test:carriers:live -- carriers/dhl` (no env vars)
checks that a synthetic number gets a clean no-data answer or a rejected session.
