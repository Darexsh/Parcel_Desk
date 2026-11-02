# DPD

DPD Switzerland (myDPD), Swiss last-mile parcels only. Germany is
[dpd-de](../dpd-de/README.md), France is [dpd-fr](../dpd-fr/README.md), the
United Kingdom is [dpd-uk](../dpd-uk/README.md), Poland is
[dpd-pl](../dpd-pl/README.md), Belgium is [dpd-be](../dpd-be/README.md), the
Netherlands is [dpd-nl](../dpd-nl/README.md), Hungary is
[dpd-hu](../dpd-hu/README.md), and the group's network in Italy is
[BRT](../brt/README.md).

## How it works

1. `direct`: the myDPD Android app's guest API. A Firebase installation and
   Remote Config supply the public app credential, which obtains an OAuth token
   for the parcel-details call. Tokens are cached per instance. Concurrent
   lookups share a refresh; cancellation does not poison later lookups.
2. `page`: the rendered Swiss consignee page recovers from inconclusive guest
   replies, transport failures or mismatched identities. Cloudflare challenges
   require the browser service configured by `FLARESOLVERR_URL`.

A parcel-details 404 establishes absence, as does a 400 typed
`PARCEL_NOT_FOUND` to a lookup without a postcode. A lookup with one is first
retried without it, because DPD also answers a wrong postcode with a 400
(`PROVIDE_ZIP_CODE`). Other 400s and a 404 in the login chain do not establish
absence. Persistent service-unavailable replies end the lookup; other guest
failures can enter the page tier. Both tiers share the caller's deadline and
signal.

## Notes

- Labels print a check character after the fourteen digits. A number typed with
  it is looked up by its digits; a character that does not match is refused as
  a typo. The German, UK and Polish adapters do the same, and detection offers
  the DPD networks for that form only when the character matches. The fourteen
  digits carry no check of their own.
- Fourteen digits is also the shape of other DPD networks and carriers. A
  number starts with the depot that printed the label, and detection suggests
  DPD Switzerland first from 0600 to 0619: DPD Switzerland's claim forms ask
  for a parcel number starting with 060, and its depots run to 0619. DPD
  Austria's begin at 0620. The suggestion never selects the carrier.
- A delivery postcode is optional and sent only to DPD. It unlocks verified
  scans, places and the delivery window. A rejected postcode is retried once
  without verification, with `dpd_postcode_verified: false`.
- The postcode is the recipient's, in any country's format. The guest service
  also answers for parcels DPD delivers outside Switzerland, and a parcel filed
  under this carrier can be one of them, so the input is not held to four
  digits. DPD answers a postcode of the wrong shape like a wrong postcode.
- Automatic recognition requires the requested identity, dated activity and
  an explicit Swiss current country. Another country returns false; missing
  country evidence is inconclusive. A scan country is not a verified
  destination. Recipient fields and the issuing business unit cannot replace
  country evidence.
- Verified scans use the offset of their matching history entry where the
  pairing is unambiguous. Otherwise their local clock uses `Europe/Zurich`.
  This preserves repeated autumn-hour instants instead of choosing an offset
  from an unrelated scan.
- The page's summary, and a page row without a time, show a date alone. Such
  a step keeps its day in `local_time` rather than an invented midnight.
- Scan codes take precedence over history enumerations. Unknown wording stays
  visible without an invented milestone. Scans are sorted newest first.
- A scan code is mapped where a live lookup paired it with a history
  enumeration, or where DPD's label names one movement: `HUI`, `HUS`, `DLS` and
  `DLQ` are hub and delivery-depot scans. `ORI` and `SPL` read like
  `IN_TRANSIT` and appear on both sides of the origin depot, so they stay
  unmapped. `statusMap` in [status.ts](status.ts) lists every code and label
  left unmapped on purpose, for the app's review queue, such as `ENA`, a data
  exchange inside DPD's systems seen before the parcel reached the origin depot.
- When DPD's unit in another country takes the parcel, the group's history
  dates `PARCEL_HANDED` anew, after the parcel's later milestones. Dated after
  one of them, it is that hand-off between units and reads as in transit, as
  does the parcel's current stage while it is the newest milestone: its label
  alone would read as acceptance.
- A proof-of-delivery bookkeeping entry is omitted when the actual delivery
  scan exists, so it cannot shift the delivery time. Delivery estimates are
  omitted after completion or an exception.
- Verified scans include notices that state the delivery day, and DPD's email
  notice adds a window. The newest notice supplies a missing estimate or the
  window for the reply's own day; a different day in the reply wins. An
  unreadable newest notice leaves no estimate, and a notice lapses at a pickup
  point or once a later scan passes its day. Notices remain events.
- Some scans are notices, not movements. `MSDLX`, DPD failing to send the
  delivery details, reads like a failed round to the shared wording rules.
  `ENA` (DPD's internal data exchange), `SPE` (a delivery estimate), `MSDLO`
  (the emailed notice for the delivery round), `MIDLI`, `MII` and `MIA` (the
  recipient's delivery instruction and its receipt) and `OTHER` (the guest
  API's catch-all) read as in transit, even while DPD has only the label. Each
  keeps the stage of the scan before it and is never the summary; the estimate
  stays in `expected_delivery`.
- While the parcel waits at a Pickup shop, the pickup point is the shop's
  name, then its street and its town on their own lines. Verified scans carry
  the shop's PUDO id: the newest scan with one names the shop, unless a depot
  scan came after it, as after the sender's drop-off at a shop. The German DPD
  app's `getParcelShopByID` ([shared service](../dpd-de/service.ts)) answers
  for Swiss shops too, and its record must name the same id. It gives the
  street and town in capitals. The reply's own shop name wins over the
  record's. A delivered parcel has none, collected there or not.
- That service needs an anonymous session, which takes tens of seconds to
  open. DPD Germany shares it, and a long-lived host opens it ahead with
  `warmDpdSession()` ([how it is kept](../dpd-de/README.md#app-service)). A
  lookup waits for it within its budget, keeping five seconds to answer
  without the address, and the opening continues for the next lookup. Without
  the record the pickup point keeps the reply's name, or stays empty.
- `receiverName` and the `receiver` object are never read as the pickup
  point: they can name the recipient.
- Public, app-restricted Firebase identifiers are part of the anonymous app
  protocol and are included in the adapter.

## Limitations

The group-wide API's identity echo alone does not establish Swiss activity.
Recognition uses only the guest tier; an outage remains a failure instead of
classifying the number as unknown. Without a postcode, places, verified scans
and the pickup shop's address are unavailable. Recipient details, addresses,
delivery-proof URLs and preference links are discarded.

The guest API has no shop lookup by PUDO id. DPD Switzerland's website lists
shops near a coordinate, with ids and addresses, from
`www.dpd.com/ch/en/online-shipping/resources/get-pudo-points` without a key;
it cannot search by id.

The [Dutch myDPD page](https://www.dpd.com/nl/nl/ontvangen/) links to the same
Geopost Android package, `com.dpdgroup.chatbot.lemny.prod`, and
[dpd-nl](../dpd-nl/README.md) reads its guest API with the Dutch business unit, as
[dpd-hu](../dpd-hu/README.md) does with the Hungarian one.
The German national app has a separate
[SOAP service](../dpd-de/README.md#app-service), which this adapter asks only
for Pickup shops.

## Links

A link to DPD's group site, `www.dpdgroup.com` or `www.dpd.com`, with the number in
`?parcelNumber=` names the network of the country its path starts with: `/ch/` names this
carrier, and the other countries with a DPD network in the catalog name theirs. Any other
country's path names none.

## Testing

`npm run test:carriers:live -- carriers/dpd` checks the anonymous negative path.
Fixtures are synthetic and cover both response shapes
([fixtures/README.md](fixtures/README.md)).
