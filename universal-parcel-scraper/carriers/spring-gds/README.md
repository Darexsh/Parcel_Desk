# PostNL

Dutch S10 numbers ending in `NL` and PostNL's `3S…` barcodes, tracked through the keyless
API behind `postnl.post`, and for a `3S` parcel sent within the Netherlands through PostNL's
domestic tracker with its delivery postcode. The folder id stays `spring-gds` (PostNL's
international subsidiary, formerly Spring Global Mail, a name providers still give it) because
stored parcels, the detection corpus, the published contract and the native catalog all carry
it; everything user-facing says PostNL.

## How it works

1. `domestic`: only for a 13- or 15-character `3S` barcode given with a Dutch postcode, or with
   another country's postcode and that country (`postcodeCountry`). A GET to
   `jouw.postnl.nl/track-and-trace/api/trackAndTrace/{barcode}-{country}-{postcode}`, the request
   PostNL's own tracking page makes, with the postcode sent without spaces or hyphens: the page
   splits that key on hyphens.
   - The reply keys parcels by barcode under `colli`; only the entry whose `barcode` equals
     the requested number is read. An empty `colli` answers an unknown barcode and a wrong
     postcode alike, so it stays inconclusive and the next step runs. So does any other
     failure of this step: it gets at most half of the budget.
   - `observations` come newest first with a stated offset, an `observationCode` kept as
     `provider_code` and an English `description`. The delivery is not among them:
     `isDelivered` says it happened and `deliveryDate`, when present, dates it. The status
     phase alone is not read as delivered, because it already reads so while a parcel waits
     at a pick-up point. An announced parcel without observations is kept as a summary.
   - The reply names the recipient, the sender and their addresses; none of that is read.
     Errors leave out the request address, which holds the postcode.
2. `direct`: two POSTs on the same host.
   - `postnl.post/api/v1/auth/token` returns a visitor token that lasts a day
     (`expires_in`). An empty or implausibly long token is refused.
   - `postnl.post/api/v1/tracking-items` takes the barcode with that token. The answer echoes
     a batch; only the item whose `item` equals the requested number is read.
   - Each call replays once after a transport failure or HTTP 502/503/504, and after a 429
     only when it carries a short, valid `Retry-After` that ends before the lookup does;
     a longer wait fails the lookup at once, leaving the rest of the host's budget to other
     sources. Both calls share a cancellable deadline; other errors are not retried. A 429 left standing is a rate limit whose
     message names the call and the wait PostNL asked for, or that it named none, so a
     host's log shows whether waiting longer would have served the lookup.
   - Unknown barcode: an ordinary item with no events and "barcode was not found" in
     `message`. "Barcode was incorrect" means the same only for a 15-character `3S` barcode
     with a four-letter customer code, the layout the endpoint reads, where it marks a code
     PostNL did not issue, such as DHL eCommerce's. Those phrases are the only part of
     `message` read; the rest is provider prose that must not reach an error or log.
   - An empty history without that message is a `NoHistoryError`, inconclusive: PostNL lists
     mail from abroad it does not hold yet the same way. Duplicate matching identities are
     refused. HTTP 404/410 means the endpoint is unavailable, not the parcel missing.
   - "Barcode was not found" for a 13- or 15-character `3S` barcode asks for the delivery
     postcode: PostNL's international tracker does not hold parcels sent within the
     Netherlands. With a postcode it takes, the domestic tracker has already been asked, so
     the lookup stays inconclusive; a postcode that is not Dutch and comes without its country
     is reported as not matching.

## Notes

- Token and lookup are one step: same host, same failure modes, so a second tier would add
  telemetry without a recovery path.
- One token serves the adapter's lookups until five minutes before it expires. The token
  endpoint's quota of 20 a minute is shared beyond one client and answers HTTP 429 past
  it, so a token per lookup failed at a low request rate. A kept token PostNL refuses
  (HTTP 401) is replaced once; a reply without a lifetime serves one lookup.
- `datetime_local` is the scan's local time even though PostNL appends `Z`. Each scan is
  re-read in the zone of its own `country_code`. Countries spanning several zones (US, CA,
  BR…), Spain and Portugal's mainland/island clocks and ambiguous daylight-saving clocks
  retain `local_time`. Invalid date text and unexpected nonzero offsets remain separate. The
  host archives these rows and asks providers for dated progress when the current clock
  cannot be resolved.
- Scans without a country are PostNL's own records (pre-advice, the shipper's data) and are
  read on Amsterdam time. Only that reading keeps them in PostNL's newest-first order among
  the customs stamps of a delivered parcel, and Swiss Post's copy of a pre-advice shows the
  same clock as `+02:00`. The label's creation and the processing record without a country
  are read as UTC instead: shippers' own copies of the label stamp show UTC, and only that
  reading fits the processing record between its dated neighbours. Each reading stays a
  guess: it is dropped when it breaks the order of the dated scans around it or lands after
  the lookup.
- Stamps with seven fraction digits (customs, bagging) carry a real `Z`: read as local
  times, they would break the list's order.
- The domestic tracker's labels carry no category. The shared wording rules stage them,
  except three they read as in transit: PostNL's announcement, its receipt and the driver's
  round.
- Categories supply the status. Exact English labels refine the categories that cover
  several milestones: sorting and the delivery round within `Processing`, PostNL's own
  acceptance within `Transit`, customs release within `Customs`, and a completed return
  within `Undelivered` ("will be returned" can still end in a new delivery attempt).
  Unknown categories leave the event unstaged and the shipment status unknown.
- Each scan keeps its numeric `status`, a slash and its category, trimmed and in lower case, as
  its `provider_code` (`37/delivered`); a scan without a category keeps its number alone. The
  parcel app's review asks the same map (`statusMap`) by that code, so it stages a scan by its
  category and label as the adapter does. A domestic observation, or a scan stored with its
  number alone, is read by the domestic labels. Adding the category changes no stored scan's
  identity, which the app keys on its time, place and wording.
- `unsuccesfull` is PostNL's own spelling. The corrected spelling is mapped too, so an
  upstream fix loses nothing.
- The item's `destination_code` becomes `destination_country`. The host uses it as a hint to
  propose one national-post confirmation for S10 numbers (see
  [routing](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)).
- The reply names no sender, recipient or address. Only the fields above are read; the
  fixture carries a recipient, an address and a signature link so the test can assert that
  they stay out.
- PostNL's `3S` barcodes nearly all carry a four-letter customer code, which selects PostNL.
  DHL Parcel prints `3S` barcodes as well, mostly with three letters, so those go to
  [DHL eCommerce Netherlands](../dhl-ecommerce-nl/README.md); a few barcodes of each carrier
  land with the other. Shorter codes, such as the two-letter ones PostNL's barcode
  documentation shows, stay suggestions. Recognition never asks PostNL about them: its
  endpoint calls them incorrect (see Limitations).
- The international tracker also holds parcels for Italy under `1810` and fourteen digits, a
  series no public source shows; the corpus holds a made-up number in that shape. bpost and
  Ecoscooting take any eighteen digits, so `spring-gds-1810` only suggests PostNL, and
  recognition asks PostNL about that series alone. Other eighteen-digit numbers stay unasked.
- `mailingtechnology.com/tracking?tn=` (Spring GDS) and retired `postnl.post/details/{n}`
  links are recognized when pasted. New links use `/track?barcodes=`.
- Not used: the Spring GDS portal. It shows extra internal legs for the same barcode, but it
  is a second undocumented surface for a marginal gain.

## Limitations

- No delivery estimate: the endpoint publishes none, so `expected_delivery` is always null.
- The endpoint answers "The shipment barcode was incorrect." for 13-character `3S` barcodes,
  which are PostNL's (Parcel EU among them), and for 15-character ones without a four-letter
  customer code. The lookup then stays inconclusive.
- The tracking endpoint enforces a per-minute call quota shared beyond one client, so a
  lookup can meet HTTP 429 at a low request rate. The replay after its one-second
  `Retry-After` can meet the same quota; the lookup then fails as a rate limit.
- A `3S` parcel sent within the Netherlands is only on PostNL's domestic tracker, which shows
  it only with its delivery postcode. Without one, the lookup asks for it and other sources
  are asked. The domestic tracker also shows parcels PostNL delivers abroad, under the
  destination country and postcode. A postcode is read as Dutch unless its country comes with
  it, so a parcel bound abroad is looked up there only when the consumer knows the
  postcode's country.
- The endpoints are undocumented and can change without notice.

## Testing

`npm run test:carriers:live -- carriers/spring-gds`. It checks that a never-issued S10
number returns a clean 404. With `SPRING_GDS_TRACKING_NUMBER` set to a live parcel, as a
consumer stored it, it also checks that `trackCarrier` returns that parcel's history; for a
`3S` parcel sent within the Netherlands, set `SPRING_GDS_POSTCODE` to its delivery postcode.
