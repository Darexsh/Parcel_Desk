# Packeta

The Central European locker and pickup-point network (Zásilkovna in Czechia), last mile in
CZ, SK, HU, RO and PL. Tracked through the keyless endpoint behind the public tracking page.

## How it works

1. `direct`: one `POST https://tracking.packeta.com/api/getPacketById/{code}/en`. No cookies,
   headers, account or browser state.
   - The echoed `barcode` must match the request, with or without its `Z` prefix,
     otherwise `SchemaError`. The public API returns the ten barcode digits.
   - Ten digits typed without the `Z` are the same packet: the API, older links and
     brokers show them that way. Detection selects Packeta for the `Z` form and only
     suggests it for the bare digits, which other carriers print too.
   - Unknown codes come back two ways, both `NotFoundError`: HTTP 404 `{"error":"notFound"}`,
     or HTTP 200 carrying the same `notFound` error instead of `item`. Expired codes answer
     the same 404, so unknown and expired look identical.
   - Other API errors, and an HTTP 404 without that error signature, remain inconclusive.
     Another unsuccessful HTTP response is `UpstreamHttpError`.
2. `recognize` makes the same request, so recognition can ask Packeta about ten bare digits.

## Packet IDs

Packeta's API documents a packet ID as a ten-digit integer and the barcode as that ID after a
`Z`, printed `Z 123 4567 890`. No check digit is documented, and neighbouring IDs belong to
packets created months apart, so nothing narrows the bare form beyond its first digit, which
is never 0. The bare rule takes the digits as typed, or in Packeta's 3-4-3 grouping; a dash
after nine digits is CDL's order number.

## Notes

- The locale is pinned to English. Event sentences are the only per-event signal, and a
  fixed locale turns them into a stable vocabulary that substring matching can classify.
- Two independent maps: `packetStatusId` sets the parcel's stage, the canned sentences set
  each event's stage. The overall stage never borrows from the sentences. The app's review
  asks the sentence map (`statusMap`), since a scan keeps no code.
- The `packetStatusId` names come from the tracking page's own script. Only `3` (delivered)
  and the returns `5` and `21` are confirmed live; the other ids are reconstructed. The script
  names `21` LOST_OR_UNKNOWN, but its live wording is "Return (on the way back)", so it maps to
  `returned`. An unmapped id is treated as schema drift: `unknown`, no guessed stage.
- Times are naive and read as `Europe/Prague`, the zone the backend stamps. The result
  carries `timezone: Europe/Prague` so clients render them correctly. Stamping UTC would
  shift every event by one or two hours.
- `sender` (merchant) and `branchAddress` (Z-BOX or partner shop) are kept as sender name
  and pickup point; neither holds recipient data. Recipient name, address, phone and
  signature are never read; a test asserts it.
- For a parcel a courier brings to the door, `courierId` is `"1"` and `branchAddress` names a
  home-delivery branch, such as "PL Home Delivery HD", which Packeta's page does not link to.
  Such a parcel has no pickup point at any stage. Neither has a returned one: its branch is
  then a depot or the point it no longer waits at. A delivered parcel keeps the pickup point
  only when its last movement before the delivery made it ready for pickup there.
- At most 20 events are returned, newest first.
- The reception and the notice of a parcel ready for pickup end with their depot or point, and
  the depot arrival names its depot within. That place becomes the scan's location, and a scan
  stored with it in the wording keeps its row in the app.
- A courier hand-off sentence links the partner's number to the partner's tracker. The
  wording keeps the number and loses the link; a scan stored with the link keeps its row in
  the app. A host the catalog knows names the partner in `delivery_carrier`, and the number
  becomes `delivery_tracking_number` when the link holds it and the partner's own rules offer
  it, so DPD Germany and InPost are asked about their own parcel numbers.
- Links use the canonical `/en/{code}` path; the legacy `?id=` form 301-redirects to it and
  is still recognized.

## Limitations

- No delivery estimate. Only the reception, the depot arrival and the pickup notice name a place.
- Romanian (EET) depot scans can be one hour off: the backend stamps Prague time.

## Testing

`npm run test:carriers:live -- carriers/packeta`. The wrong-number check
needs no env vars; set `PACKETA_DELIVERED_TRACKING_NUMBER` to also check a real delivered
parcel.
