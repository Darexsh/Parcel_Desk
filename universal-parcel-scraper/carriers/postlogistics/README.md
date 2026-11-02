# PostLogistics

Swiss Post's logistics arm, now trading as Swiss Post Cargo. Its tracker moved
from `tracking.postlogistics.ch` to `apv.swisspost-cargo.com`, and it is tracked
through the keyless endpoint behind it. The old hosts answer 404; their links
still identify this carrier, as does a printed reference in a link to the new
tracker. It accepts barcodes and customer references. A
printed eight-digit reference with a dashed three-digit suffix identifies this
carrier. Compact 11-digit numbers are ambiguous; carrier recognition checks
them when tracking has no confirmed carrier. Other identifier shapes need the
carrier to be picked. Ordinary Swiss Post parcels go to
[swiss-post](../swiss-post/README.md).

## How it works

`direct`: `POST https://eosapi.swisspost-cargo.com/api/trackandtrace/public?culture=en-EN`
with `{"Identifier": "…"}`. No session, cookie or token; 15 s total timeout.
Stored numbers omit punctuation, so an unknown 11-digit lookup tries the dashed
eight-plus-three spelling before returning 404. A successful undashed lookup
is kept. Same endpoint and protocol as [swiss-post-cargo](../swiss-post-cargo/README.md).
Recognition uses the same lookup and requires a scan before claiming a match.

- `Data: null` is the explicit unknown-identifier answer and becomes a 404.
- `Type: 1` is a barcode lookup: only the shipment whose `Identifier` equals the
  requested barcode is read, because the answer can include neighbouring shipments.
- `Type: 2` is a customer reference. References are shared, so only the one
  current consignment among the returned barcodes is merged, and an answer
  without one is a 404. The rule and its reason are in
  [swiss-post-cargo](../swiss-post-cargo/README.md). A `Type: 2` answer with no
  resolved barcode is refused — nothing ties the history to the reference.
- `Type: 3`, which the tracker's published source map does not name, is a Swiss
  Post parcel barcode PostLogistics does not hold. The endpoint relays Swiss Post's
  own scans, each coded `PST`, with no place and in German whatever the culture.
  Once the echo matches the barcode, it becomes a 404 and routing moves the parcel
  to [swiss-post](../swiss-post/README.md). Reading the relay would keep the
  parcel on a thinner copy whose `PST` codes never say delivered.
- Any other `Type` is refused rather than guessed, which could show someone
  else's parcel.

## Notes

- History is sorted by absolute instant — merged references interleave barcodes
  with different offsets, so array order would put an older scan on top. The
  endpoint lists a history oldest first, so of two entries that share an instant
  the later one goes on top.
- An `IMG` entry records the picture taken with a scan and shares that scan's
  instant. It is dropped: left in, it would sit on top of the delivery scan and
  the shipment would never read as delivered. One that stands alone is kept
  without a stage; live histories show the delivery picture up to a minute
  before the delivery scan.
- Confirmed codes set each scan's stage and the newest scan's summary. This keeps
  a data announcement registered when its wording has no classification rule,
  and distinguishes acceptance and delivery-round scans. Unknown codes leave
  the stage to wording; an older scan never inherits the shipment's final stage.
- The estimate is `DriveAndArrive.PlannedDeliveryDate`, falling back to
  `EstimatedArrival`. The newest delivery scan's time is the delivery time.
- Each scan keeps its three-letter code as `provider_code`.
- The endpoint words its scans in the language `culture` names and ignores
  `Accept-Language`, so the adapter asks for English. Codes, clocks and places are the
  same in every language. A scan stored in French takes the English wording in place:
  at its instant, its code identifies it.
- Timestamps are kept as sent; the host applies `Europe/Zurich` when there is no offset.
- Recipient and signature blocks are never read; the fixture exercises this.

## Limitations

- The endpoint is undocumented and can change without notice.

## Testing

`npm run test:carriers:live -- carriers/postlogistics` checks
that an unissued barcode returns a clean 404. Set
`POSTLOGISTICS_LIVE_TRACKING_NUMBER` outside the repository to a current barcode
or reference to check a shipment, or `SWISS_POST_TRACKING_NUMBER` to check that a
relayed Swiss Post parcel returns 404 so routing can select Swiss Post.
