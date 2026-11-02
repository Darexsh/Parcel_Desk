# InPost

The Polish locker and courier network and its cross-border hubs (last mile in PL, IT, PT and
GB). Tracked through the keyless `inposteasy.com` hub API; no postcode or link needed.

## How it works

1. `direct`: one `GET https://inposteasy.com/api/tracking/{trackingNumber}?language=en` (without `language` for a Polish reader). No cookies,
   account or browser state. A hub-confirmed collection can also query ShipX
   for its pickup point within the remaining budget.
   - The echoed `trackingNumber` must match the request, otherwise `SchemaError`.
   - HTTP 404 is not-found only when the structured `NOT_FOUND` problem identifies the
     requested shipment, directly or inside the tracking-error wrapper. An unrecognized
     404 stays inconclusive. Long-expired numbers also return not-found.
   - Transient HTTP failures get one retry within the lookup budget. Other failures keep
     their HTTP status, retry window and bounded diagnostics.
2. `shipx`: a parcel-specific hub tracking error with HTTP 500 can query the keyless Polish
   ShipX route for a 24-digit number. The whole identifier, an InPost courier or locker
   service, and a current status matching the newest explicitly dated scan are required.
   It returns a status-only answer, marked `summary_only`, so a fuller provider history
   remains eligible. Unknown statuses and ShipX absence leave the hub failure inconclusive;
   generic outages, rate limits and definite hub negatives never start this step.

## Notes

- The parcel-level `status` code sets the overall stage and each event's own code sets that
  event's stage; the two are independent in the payload.
- A drop-off at a locker or a courier collection reads as accepted, a parcel handed to the
  courier for delivery as out for delivery, and a refusal as a failed attempt.
- A parcel stored in a nearby locker while its own is full is ready for pickup there, since
  the same code opens it. When that storage expires it is in transit again, on its way to
  the chosen locker.
- An unmapped code gets no stage: the phase prefix does not decide it. The result is
  `unknown` with the raw wording kept, and the sync records it for review.
- Scans keep their wording and their code (`provider_code`). The parcel app's review asks the
  same map (`statusMap`) by the code, and a copy without one by its wording, through the code
  `statuses.json` records it with; a redirect or a delay notice stays without a stage there,
  since it takes the stage before it. Adding the code changes no stored scan's identity, which
  the app keys on its time, place and wording.
- Timestamps are kept exactly as sent with their offset. An offset-less value is dropped,
  not stamped with `Europe/Warsaw`, because four countries share this endpoint.
- The hub words every parcel's scans in Polish, whatever its country or the
  `Accept-Language` header, unless `language` is set. A lookup whose `language` is Polish
  gets that; any other asks for English. Codes, clocks and places are the same in every
  language. A scan stored in one language takes the other's wording in place: at its
  instant, the same stage and place identify it.
- An empty `statusTitle` falls back to the raw code so a sparse event still reads as
  something.
- At most 20 events are returned, newest first.
- `JJD`/`JD` + 16 digits and bare 24-digit numbers are low confidence: `JJD` collides with
  DHL and needs a domain hint or an explicit pick. `JJD` and sixteen digits is the plate
  Yodel, InPost's UK network, prints, and no DHL sample has that length, so `inpost-2` puts
  InPost first for it, with DHL beside it.
- bpost, Ciblex, Austrian Post, Express One and Iran Post print 24 digits too. Express One's
  can open with 60, as InPost's do, and Iran Post's leading digits vary, so a bare 24-digit
  number stays low confidence. Detection lists InPost first, ahead of the country hint, for the
  leading digits its tracker has answered, and keeps the others as candidates.
- Yodel, InPost's UK network, also prints two digits, three letters, seven digits, `A` and
  three digits. Nothing in that layout names InPost, and ArrowXL's references share it, so it
  is low confidence too.
- Links carry the number. The Polish page does not find Yodel's layouts, so those open
  InPost UK's page, where Yodel's former tracker now forwards them.
- Each event keeps its place, a town or hub with its country. A delivered parcel keeps
  its delivery time, and the destination country is kept; the origin country is not.
- Recipient name, address, phone and signature fields are never read; a test asserts it.
- The separate keyless ShipX route is `GET https://api-shipx-pl.easypack24.net/v1/tracking/{number}`.
  Its [official schema](https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/11731050)
  includes locker names and addresses in `custom_attributes.target_machine_detail`.
  `expected_flow` contains forecast stages, not completed scans or a delivery estimate.
  Its point is added only for the same whole identifier, with matching collection
  progress and a scan clock no older than the hub's. It must identify a locker or
  public pickup service. Delivered parcels require actual collection evidence;
  planned destinations, door deliveries and returns have no point. ShipX history
  never replaces hub history: its wording, places and clocks can differ and create
  duplicate scans. The status-only fallback uses the actual scan clock, never
  `updated_at` or the forecast. A delivery reminder at an address means an unsuccessful
  delivery attempt, not a parcel ready for collection. Its
  [status vocabulary](https://dokumentacja-inpost.atlassian.net/wiki/spaces/PL/pages/18153478/Statuses)
  defines these distinctions. ShipX failure leaves a healthy hub history usable.
  Recognition uses the hub alone.

## Limitations

- No delivery estimate. Pickup details depend on ShipX coverage and current
  collection evidence; the hub's place alone names only the town.

## Testing

`npm run test:carriers:live -- carriers/inpost`. The wrong-number check
needs no env vars; set `INPOST_DELIVERED_TRACKING_NUMBER` to also check a real delivered
parcel.
Set `INPOST_PICKUP_TRACKING_NUMBER` to also check a parcel ready for collection
or collected at a point.
