# 99minutos

Tracks 99minutos parcels in Mexico, Chile, Peru, Colombia and Argentina through the service
behind 99minutos's own tracker.

## How it works

The tracker at `tracking.99minutos.com` is a single-page app that asks
`tracking-prd.hub.99min.io/api/v1/tracking/` for everything, and so does the adapter, in the
same three POSTs: the search (`concerns`, with the number, the fixed token `secure` every visitor
sends and the `search` action header), then the shipment's summary (`{id}/track`) and its
history (`{id}/detail`), which go without a body or a content type, as the service refuses an
empty JSON body. No account, cookie, key, CAPTCHA or browser is needed. Redirects are not
followed. A request that fails to reach 99minutos is sent once more within the budget.

The search answers each number with a status. `error`, the tracker's "El número de seguimiento
no es válido", is the only missing shipment. `validate` and a summary or history refused with
HTTP 401 mean the tracker wants the recipient's email, phone or name first, which the adapter
reports as required input. The summary's bare 404 and the history's 500 relay a failed lookup
and stay inconclusive, as does a reply about another shipment. A browser challenge, rate limits
and other HTTP errors keep their own failure kinds. Recognition uses the same lookup.

## Numbers

99minutos's tracker asks for the guía, the shipment's numeric tracking id. Archived lookups show
nine and ten digits; the adapter takes seven to ten. Its help page also describes lettered
layouts starting `99MEX` or `MX`, but none was seen in a lookup, so they are invalid without a
request. The search also resolves shops' order references, which can name another shop's
parcel: only a result whose tracking id is the requested guía is read. Nine and ten digits are
shared with TNT, DHL and several other carriers, so detection offers no 99minutos rule and
recognition is not asked for them; 99minutos tracking runs when the caller names the carrier.

## Notes

- Each row's provider code is the tracker's status name, such as `ToDelivery`, the key of its own
  wording table; the summary carries the same names. The map is in [status.ts](status.ts).
- The summary's status decides the stage, as on the tracker's progress rail. A summary code the
  tracker shows as an incident makes it a problem whatever the name.
- Rows are listed newest first, once each. Colombia's tracker lists only the order, the
  collection, the linehaul, the departure for delivery and the delivery, and so does the adapter.
- Clocks are instants with their offset; the tracker shows them in the viewer's own zone.
- The estimate is a day, as on the tracker, which shows it with a fixed window from a station on
  and hides it in Chile and Peru. Its day is taken in the country's main zone, and an estimate
  older than the newest row is dropped.
- For an international shipment the tracker sends the visitor to UPS with the shop's internal
  key, and the adapter hands the parcel over to UPS when that key is a valid UPS number.
- The summary also carries the origin and destination addresses and stations, and the history
  the drivers' and stations' remarks, which name people, and the delivery evidence. None of them
  is read, nor is the map.

## Links

The tracker opens a parcel at `tracking.99minutos.com/search/{number}` and goes back to its
search for an unknown one. Older lookups used the same path on `www.rastreo.99minutos.com` and
`beta.tracking.99minutos.com`, and `99minutos.com/tracking/{number}`; the library reads the
number from all of them.

## Live test

Set `NINETYNINEMINUTOS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/99minutos/adapter.live.test.ts`.
Optionally set `NINETYNINEMINUTOS_UNKNOWN_NUMBER` to check a guía 99minutos does not know.
