# SkyPostal

SkyPostal carries cross-border e-commerce parcels, many of them Amazon orders, from its Miami hub
to Latin America and hands them to a carrier in the destination country, keeping its own number
on its tracker. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://gtw.skypostal.com/api/secure`, sealed as the tracking page seals
   it. The body is `{"payload":"…"}`, the lookup
   `{"action":"asyncSingleTracking","trackingSearch":"{number}","lngCode":"ENG",…}` sealed with
   AES-256-GCM under a key PBKDF2 derives from a passphrase in the page's script. The `x-guid`,
   `x-skpdata` and `x-sdata` headers carry a fresh visitor id and the visitor's details sealed
   under half the id's MD5, and the lookup names the guest account the script uses for every
   visitor. It needs no cookie, session or browser. The reply is sealed the same way and holds
   the scans, newest first.

- An unknown number is HTTP 200 with one row carrying error `10001`, "No information available".
  A 404 or a redirect is a moved route.
- The scans belong to one shipment, and one whose label is the number asked names it. Until the
  destination partner's scans arrive, the scans may carry only SkyPostal's own label. The adapter
  then asks the summary the page shows for several numbers (`shipmentSearchMultipleSkp`), which
  names the shipment's external number. That lookup takes several seconds.
- The gateway allows twenty lookups a minute from one address, then answers 429 with
  `Retry-After`. It answers a request it cannot open with its own 403 JSON, which the adapter
  reports as a changed reply; any other 403 is a challenge.
- Recognition makes the same request.

## Notes

- Each scan's `entry_date_str` is a wall clock to the second, with no zone. The Miami scans are
  Miami's clock, and the destination partner's scans arrive in the partner's local time. One
  partner's scans came twice, from two feeds four hours apart, so the clocks stay `local_time`.
- Because of those twin feeds, a delivery stands over a later scan of an earlier stage. A later
  problem or return stands over the delivery.
- The description is SkyPostal's English wording and the code stages it. `DTP`, the airline's
  handover to the ground operator at the destination airport, and `PRH`, a partner's transfer
  hub, read as a delivery and an acceptance by wording, so their codes decide. Billing steps, the
  fuel surcharge and `OTH`, seen as a hold's release, have no stage.
- The location is the partner's town when the scan gives one, otherwise SkyPostal's station code,
  such as `MIA`.
- The comments column, the proof-of-delivery image and each scan's label are not kept. Comments
  can name the person who took the parcel.
- A scan's label is the number the parcel then travelled under: SkyPostal's own label at the hub,
  then the partner's. On recent shipments the partner's is the number asked, so there is no
  hand-off.

## Limitations

- No delivery estimate, weight or service, and no delivery time as an instant.
- The page's cargo view, for air waybills, is not read. A number the tracker knows only as an air
  consignment is inconclusive.
- The tracker also answers other references a shipment carries, which no rule claims.

## Numbers

SkyPostal's tracker and customers' complaints show two layouts. `SKAMZUS` and ten digits is
claimed by `skypostal-1`; Colis Privé's low rule also accepts some of these
seventeen-character numbers. `SP`, eleven digits and `BR` is suggested by `skypostal-2` at low
confidence, because it is seen only on older Brazil shipments. Recent shipments' hub scans carry
a label of `SP`, twelve digits and `BR`, which no rule claims. The tracker also follows Correios
international numbers for Brazil parcels; generic postal detection handles those. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The home page's tracking box opens `tracking.skypostal.com/?trck_number={number}&lng_code=ENG`.
Older lookups used `tracking.skypostal.com/single-tracking.aspx?trck_number={number}`. The
library reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/skypostal`, with `SKYPOSTAL_TRACKING_NUMBER` and
optionally `SKYPOSTAL_UNKNOWN_NUMBER` set outside the repository.
