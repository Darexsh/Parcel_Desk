# Mondial Relay

French parcel-shop network (last mile in FR, BE, ES, LU, PT, NL). Tracked through
the consumer app's backend when an InPost account is configured, else through
the French recipient website in a real browser, because Cloudflare blocks
direct requests to that flow.

In Spain and Portugal the network trades as InPost: `inpost.es` and `inpost.pt` run its site
and tracker, with the same 8-character shipment numbers. InPost's own hub also serves Portugal,
so only the Spanish names resolve here. InPost Spain's own `FV` numbers are read from
`inpost.es` over plain HTTP.

## How it works

1. `app` (only with `MONDIAL_RELAY_REFRESH_TOKEN`): the app backend, signed in
   as one InPost account. See [Mobile API](#mobile-api).
   - Search `parcels-search` for the 8-digit shipment and the postcode. A label
     barcode is searched by its brand and shipment (`shipmentUid`) alone: the
     checksummed barcode is the credential, as on the website.
   - The search must single out one shipment UID whose shipment (and brand, for
     10- and 12-digit forms) matches the input. Otherwise the step is
     inconclusive: the app filters on the recipient postcode only, while the
     website also accepts the sender's.
   - Read `parcels-detail` for that UID: the headline (`stepHint`), then the
     dated events of each milestone, then the highest dated milestone.
   - Any failure (refused sign-in, rate limit, unexpected reply) hands the
     lookup to `trawl`.
2. `trawl`: two requests through the browser service, on one
   solved identity.
   - Load `/suivi-de-colis/` and read the `token` attribute of `#tracking` from
     the captured response body (`trawlBody()`), not the rendered HTML: the Vue
     app replaces that root as soon as it boots.
   - Call `GET /api/tracking?shipment=…&postcode=…&brand=&codePays=fr` with the
     token as `RequestVerificationToken`, as the official bundle does. Check the
     answered URL still names the same shipment and postcode.
3. Parse the JSON from the captured body or the `<pre>` a browser navigation
   wraps it in. `Expedition.Numero` must match the requested number or its
   embedded 8-digit shipment before anything else is read.

An InPost Spain number (`FV` and eight digits) takes neither step:

1. `inpost-es`: load `https://www.inpost.es/seguimiento-del-envio/?parcelNumber=…`,
   which the server renders with no cookie or bot check, and read the props of
   its tracking component. Both `parcelNumber` and `trackingDetails.packageId`
   must be the number asked.
2. `retry`: one more read when the page cannot be reached or hangs.

A customer-reported association between references does not override this
identity check. Outbound and return legs keep separate tracking identities;
references with an unresolved prefix remain corpus evidence.

Without the app step or a browser service (`FLARESOLVERR_URL`) the lookup fails
at once with a `ChallengeError`. Lookups are serialized per adapter instance
(`singleFlight`) so the token and the API call stay on one browser identity. Errors: warning
reply → `NotFoundError`; no token → `ChallengeError`; 8-digit shipment without
a postcode, or with only the first four digits of a Portuguese one →
`InputRequiredError`; malformed number → `InvalidInputError`; a reply for another
shipment → `SchemaError`.

## Notes

- Credentials: an 8-digit shipment needs the recipient postcode, typed
  separately or, for a French one, appended. 10- and 12-digit forms are a
  2-digit brand plus the 8-digit shipment (plus parcel sequence) and need no
  postcode: the website hides its field for them and finds them with none or a
  wrong one, so a postcode typed for them is not sent. The API echoes only the
  8-digit shipment.
- The postcode is compared with the recipient's, in any country's format: a
  Belgian recipient gives a Belgian one. `codePays` only picks the reply's
  language (the same parcel is found under `fr`, `be`, `pt` or none) and stays
  `fr`, which the parsers read. A wrong postcode, whatever its shape, is a "no
  parcel" warning.
- A Portuguese postcode is held as `1234-567`. The website finds the parcel only
  in that form and the app also without the hyphen, so seven digits are sent
  hyphenated. Neither finds it by the first four digits alone: given as
  Portugal's (`postcodeCountry`), those are asked again before any request
  (`input_required`, reason `postcode_incomplete`). No other country the network
  serves has seven-digit postcodes, so seven digits without a country count as
  Portuguese.
- 26-digit label barcodes need no postcode. Both modulo-11 check digits and the
  parcel sequence are validated; the first 12 digits are the public alias used
  for links and lookups.
- Never read the barcode's routing suffix as a postcode: it looks like one, and a
  wrong postcode returns another parcel or nothing.
- The website also finds an 8-digit shipment without a postcode when it is given
  the brand code that notification links carry (`codeMarque`). The adapter has
  no input for it.
- Shipment numbers are reused: an old number can return a later parcel.
- The website echoes the shipment as a JSON number, which drops leading zeroes;
  they are put back before the identity check.
- The postcode is part of the credential: kept out of logs, links and fixtures.
  The tracking link carries `numeroExpedition` only.
- Pasted links are read from the French, Belgian, Dutch and international sites. The Belgian
  and Dutch trackers take `numeroExpedition` as the French one does, and the international
  tracker on `mondialrelay.com` takes the shipment as `exp`.
- Status comes from the `SuiviContextuel` headline, then events, then the
  highest reached milestone (its label, then its number). The deciding stage is
  set as `current_stage`, because the status vocabulary has no pickup value and
  the sync would otherwise fall back to "out for delivery".
- On a home delivery the website dates the "Colis en cours de livraison"
  milestone at the scan that sends the parcel "en route vers le point de
  livraison". That scan, and no other at that instant, reads out for delivery;
  on a relay delivery it stays movement. The app's milestones are read the
  same way. The parcel app's review asks the same map (`statusMap`), which
  leaves that scan without a stage: the stored scan does not keep the milestone.
- The website names the delivery country. A delivered parcel takes its delivery
  scan's clock as its delivery time, whichever source answers.
- Website timestamps are offset-less Paris wall-clock. A bare calendar day stays
  a day. The estimate is reduced to a day and dropped once delivered or in
  exception. App timestamps are UTC instants, shown on Paris clocks.
- The app gives no delivery estimate, so app answers have none.
- Neither source has a place field for a scan. A scan at a logistics site names
  it in its wording ("sur notre site logistique de METZ", "sur le site METZ",
  "depuis le site METZ"), and that name becomes the scan's location, without a
  country. Both sources word scans alike, so a scan keeps one identity whichever
  answers; a scan stored without its site gains it in place.
- While the parcel waits at a relay or locker, that point becomes the pickup
  point: its name, then its street and town on their own lines. The website
  gives a relay's record (`DetailPointRelais`) on the scans made there, the
  sender's drop-off included, so only a record on the scans since the parcel
  reached its pickup point counts: its arrival there and the locker countdown. The app gives the parcel's delivery point
  (`detail.deliveryPointModel`), whose first address line is its name, as the
  app shows it. A delivered parcel has none, collected there or not.
- InPost Spain's page carries `trackingDetailsStatus` in its props: 404 for an
  unknown number, 409 when it asks the recipient postcode, 200 with
  `trackingDetails`. Its milestones come newest first, each with coded scans
  (`CRE`, `FMD`, `MMD`, `LMD`, `EOL`). The code sets the stage; an unknown code
  falls back to its Spanish label, then to a movement milestone, and the parcel
  to the headline milestone. Scans are UTC instants, shown on Madrid clocks.
  The page names no scan place and gives no estimate.
- Only `FV` numbers are read there. Random 8-digit numbers mostly answer without
  the postcode, so an answer does not single out a parcel; random `FV` numbers
  do not answer.
- Recognition asks that page about `FV` numbers alone, and `mondial-relay-3` offers
  Mondial Relay for them at low confidence: TNT Italy's two letters and eight
  digits take the same characters. A 404 is unknown; a postcode request or a bot
  check is no answer. Mondial Relay's own numbers are not recognized, since they
  need the app or a browser.
- Lead: a 26-digit label barcode of a parcel for Spain answers on the same page
  without a postcode, with the same coded scans; others answer 404. Barcodes
  stay on the app and the website.

## Mobile API

The official [consumer Android app](https://play.google.com/store/apps/details?id=com.mondialrelay.mobile)
uses `https://mobile-app-bff.mondialrelay.app/`. Requests carry a shared app
signature: `X-MR-Param1` is a UUID nonce, `X-MR-Param2` the Unix time in
seconds, and `X-MR-API-KEY` is `sha256hex(sha256hex(secret + nonce + time))`.
The secret is compiled into the app and is the same for every install.
`GET /api/parcels-search` accepts `shipmentUid` and `postcode`;
`GET /api/parcels-detail` accepts `shipmentUids` and `parcelType`, and returns
history as `detail.steps[].events[]`. Both also require an account JWT, issued
by an InPost authorization-code sign-in with PKCE (client
`mondialrelay-mobile`). The parcel does not have to belong to that account.

- The access token lasts two hours. The adapter renews it from the account's
  refresh token at `https://account.inpost-group.com/oauth2/token`, once per
  expiry and once more after a 401. The refresh token is not rotated.
- A postcode search returns only the parcel whose recipient postcode matches,
  and an empty list otherwise. A 10-digit UID (brand and shipment) is found
  without a postcode; a 26-digit barcode is rejected with a 400.
- Cloudflare refuses Node's built-in fetch with a 403 page and answers the same
  request over HTTP/1.1 (`node:https`), so the app client uses that transport. A tracker's
  fetch wrapper does not replace it; a fetcher the host supplies does.

`GET /api/parcel-detail-not-migrated?shipmentUid=…` accepts the app signature
without an account JWT or postcode. The app uses it for non-exported sent
labels. Its summary replies contain shipment identity and delivery metadata,
without tracking events or scan times, so they cannot replace the public
website history. The returned numeric UID combines the brand and the complete
eight-digit shipment number; the brand remains part of the identity.

## Rejected approaches

- Direct HTTP first, browser as fallback: Cloudflare returns a 403 WAF block to
  every non-browser client, from several networks. It never succeeded and only
  burned time.
- Deriving the postcode from the 26-digit barcode: those digits are routing
  data.
- Recognizing numbers through `parcel-detail-not-migrated`: it answers for one
  brand only, and most random 8-digit numbers exist there, about half of them
  with recent activity. Existence there does not show that a number is a
  Mondial Relay parcel.
- Mapping milestone numbers first: they show progress-bar position, not what
  happened.
- Reading timestamps as UTC: the backend is Paris; offsets would be wrong half
  the year.

## Limitations

- Postcodes from countries other than France and Portugal go as typed and are
  untested.
- Scans at a relay or locker have no location: the website names the relay on
  drop-off and collection scans, but the app does not, and one scan would then
  differ by source.
- A relay's contacts, opening hours and coordinates, the app's pickup code and
  the recipient's name and postcode are never read; the offline tests assert
  none reach the result.

## Testing

`npm run test:carriers:live -- testing/browserProtectedCarriers.live.test.ts`
runs without a browser service, so it only checks the wrong-number or challenge
error.

`MONDIAL_RELAY_REFRESH_TOKEN=… MONDIAL_RELAY_TRACKING_NUMBER=… MONDIAL_RELAY_POSTCODE=…
npm run test:carriers:live -- carriers/mondial-relay/adapter.live.test.ts`
tracks a private parcel through the app alone, and
`MONDIAL_RELAY_INPOST_SPAIN_NUMBER=…` an InPost Spain number through its page. A refresh token comes from an
InPost sign-in with PKCE at `https://account.inpost-group.com/oauth2/authorize`,
redirecting to `https://account.inpost-group.com/callback`.
