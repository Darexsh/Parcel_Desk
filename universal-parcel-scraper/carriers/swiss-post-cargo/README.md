# Swiss Post Cargo

Swiss Post's domestic freight and pallet network (also trading as Hugger). It
tracks freight barcodes and customer references, not parcels (those go to
[swiss-post](../swiss-post/README.md)). Freight barcodes are often the shipper's
SSCC behind the `00` identifier. A valid one names its shipper rather than a
carrier, so detection only suggests Swiss Post Cargo and carrier recognition
asks eos. Customer references printed as `PL-` and eight digits are suggested
and confirmed the same way. Other identifiers are too generic to detect and
arrive by manual carrier choice or a tracking link from either tracker host,
`tt.` or `apv.`.

## How it works

`direct`: anonymous `POST https://eosapi.swisspost-cargo.com/api/trackandtrace/public`
with `{"Identifier": "…"}` — no token, cookie or session. 15 s timeout, 2 MB cap.
This is the endpoint the single-page tracker itself calls (protocol read from
its published source map).

- `Data: null` is the not-found answer. The endpoint returns HTTP 200 for
  unknown identifiers, so the status code cannot tell them apart; any other
  unexpected shape is a `SchemaError`.
- eos matches an identifier exactly except for case, and stored numbers lose
  their punctuation. After a `Data: null`, a letter prefix followed by digits is
  asked again with a dash between them, the way such references are printed,
  unless that spelling would pass 20 characters, which eos is slow to refuse.
  The result links the portal to the spelling eos knew.
- `Type: 1` is a barcode lookup: rows must echo the requested barcode and other
  rows are dropped.
- `Type: 2` is a customer reference, and references are not unique: the
  carrier's tracking form pairs its example `12345678` with a Betriebsnummer,
  and alone eos answers it with delivered shipments years apart. The official
  tracker lists each barcode behind a filter; a parcel needs one consignment,
  taken as the barcodes first scanned within a day of the newest one. It is read
  only while it has a scan from the last 60 days (carrier recognition's window)
  and no other barcode does ([reference.ts](reference.ts), shared with
  PostLogistics). Any other answer names no single current shipment: a 404,
  which routing treats like an unknown number rather than an outage.
- `Type: 3`, which the source map does not name, is a Swiss Post parcel barcode
  the eos system does not hold. The endpoint relays Swiss Post's own scans, each
  coded `PST`, with no place. Once the echo matches the barcode, it is a 404 and
  routing moves the parcel to [swiss-post](../swiss-post/README.md), which returns
  the same scans with their codes and places. Any other `Type` is a schema error.
- A consignment can span several barcodes; their histories are merged,
  deduplicated on (time, location, description, code), sorted newest first and
  capped at 100.
- Rows with no usable event are a schema error, not an empty success, so a
  broken shape never looks like a parcel with no news yet.

## Notes

- Negative wording (return, incident, failure) is checked before delivery words
  and codes — "Not delivered" contains "delivered", and a false delivery ends
  tracking.
- A row neither its wording nor its code names reads as movement. The parcel
  app's review (`statusMap`) leaves such a row open instead.
- `DLV` is confirmed from a capture and `POD`, `SIG` and `IMG` from live
  histories, where the delivery picture (`IMG`) comes at or just before the
  delivery scan's instant, listed ahead of it, and the signature (`SIG`) at
  that instant. `P40` is carried over from the original map as a delivery code.
- A barcode's `IMG` and `SIG` rows are folded into its delivery scan: left in,
  the picture would sit on top of the scan it shares an instant with and become
  the status text. Without a delivery scan they stay, as the only sign of the
  delivery, behind any scan of the same instant.
- The newest delivery scan's time is the delivery time; eos sends no estimate.
- Times arrive as Swiss wall-clock without an offset. They are read in
  `Europe/Zurich` (`isoTime`), never in the server's zone, and so are the
  `dd.MM.yyyy HH:mm[:ss]` and `dd/MM/yyyy HH:mm:ss` fallbacks. An explicit offset
  or `Z` is kept as sent.
- Not used: scraping the page HTML — it renders client-side, so it would need a
  browser for data the endpoint returns directly.
- The consignee block and `FullDescription` (internal operational detail) are
  never read. No proof-of-delivery or document endpoint is called.

## Limitations

- No delivery estimate: `expected_delivery` is always `null`.
- No delivery picture or signature. The public endpoint and tracker carry only
  the `IMG` and `SIG` labels, with no link, id or image data; eos serves the
  images to signed-in portal accounts (`GET /api/trackandtrace/signature/{id}`
  answers 401 without a session).
- A reference whose one current consignment belongs to someone else still
  resolves to it; nothing in the answer tells them apart.

## Testing

`npm run test:carriers:live -- carriers/swiss-post-cargo` checks
the clean 404 for an unknown number. Recognition reuses the same lookup and
needs a dated scan to claim a number. Set `SWISS_POST_CARGO_TRACKING_NUMBER`
outside the repository to a current barcode or reference to check a shipment, or
`SWISS_POST_TRACKING_NUMBER` to a current Swiss Post parcel barcode to check the
`Type: 3` relay's 404.
