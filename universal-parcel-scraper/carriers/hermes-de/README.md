# Hermes Germany

Hermes Germany (myHermes) parcels, tracked through the anonymous recipient
service the public page calls. Hermes Einrichtungs-Service (furniture) is
[hermes](../hermes/README.md). The former Hermes UK domestic service is
[evri-uk](../evri-uk/README.md), and its international service is
[evri](../evri/README.md).

## How it works

1. `direct`: `GET https://api.my-deliveries.de/tnt/v2/shipments/search/{number}`
   with `X-Language: de` for a lookup whose `language` is German and `en`, as the
   page's English route asks, for any other. Codes, clocks and places are the same
   in both, and a scan stored in one language takes the other's wording in place,
   matched by its code. HTTP 404 is a clean not-found; any other error status
   stays an upstream error.

The response must contain exactly one parcel whose `barcode` equals the
requested number. A 14-digit number that fails the barcode check digit is a
reference instead, which the search resolves to its parcel as the tracking page
does: tracking takes that one parcel and names its barcode as
`canonical_tracking_number`. Recognition still needs a reference's barcode
itself, since a reference proves no ownership of the number. A barcode asked with
a leading zero too many is answered under the barcode itself, the parcel's own
number, which tracking and recognition take the same way when the barcode passes
its check digit. `hermes-de-padded` offers Hermes for two zeros and thirteen
digits, the form the public samples show, when that check passes. Exact
`(time, parcelStatus)` duplicates are dropped, and rows are sorted newest first.
Timestamps are read with their own offset (falling back to `Europe/Berlin`) and
stored as UTC. Hermes's own scans carry UTC to the millisecond: a summer scan
at 14:00 German time reads `12:00:00.123Z`. A partner's scans abroad come in
whole seconds or minutes (`12:00:00.000Z`) and are read as UTC too, as the
tracking page shows them in the visitor's zone like Hermes's own.

## Notes

- Barcodes shared with Evri remain ambiguous across services. Longer Hermes
  barcodes retain their existing recognition. Numeric detection uses the
  published checksum as a preference, since other carriers can pass it too.
  Fourteen digits from `022` that pass it are the Hermes network's: no other
  carrier's sample starts that way, so `hermes-de-022` puts Hermes Germany
  first for them wherever the parcel comes from.
- A 14-digit number that fails that checksum and still finds a Hermes parcel
  is a reference when the parcel comes back under another barcode, which
  `canonical_tracking_number` names; detection leaves references out on
  purpose. Only a parcel whose own barcode fails the checksum questions it.
  Change `hermes-de-2` only once a second such barcode turns up, and first
  look for what the two share, such as a leading range with its own check.
- Hermes Gepäckversand, the luggage service Deutsche Bahn offers its
  travellers, is tracked by its order number, as its
  [FAQ](https://www.myhermes.de/deutsche-bahn-gepaeckservice-faq) says. The
  label with the barcode is printed only when the luggage is handed over. The
  search resolves the order number like a reference, to a piece whose
  `parcelAttributes.parcelCategory` is `LUGGAGE`; Hermes's own scan text then
  speaks of luggage. Detection leaves order numbers out like other references:
  they are plain runs of digits that other carriers print too.
- Stages come from the `parcelStatus` enum, no carrier wording rules. The enum
  is stable, and wording would only add a chance to be wrong. The enum was read
  from the carrier's public bundle `gcp-prd.my-deliveries.de/tnt/bundle/tnt-bundle-v2.js`.
- Hermes's depots and ParcelShops are placed in Germany. A partner abroad
  (`INTERNATIONAL_…` codes) names its depot and then its country, "prepared in
  EXEMPLEVILLE for further shipping (France)", so its depot is placed there.
- The sender's drop-off at a ParcelShop (`PARCELSHOP_DROP_OFF`) reads as accepted,
  like a drop-off at another network's parcel shop: the shop takes the parcel in
  for Hermes. The driver's collection from the shop follows it.
- A row with an unknown code carries no stage of its own: the shared wording
  classifier reads its text. As the newest row, with nothing saying delivered,
  it reports the shipment as `unknown` with the history intact. Defaulting to
  `in_transit` could hide a new failure code.
- Every row keeps its `parcelStatus` as `provider_code`. A row with
  `historyText` only changes stage when its code is mapped. A row without that
  text takes the code's own description instead of "Hermes tracking update",
  which changes its stored identity, so [identity.ts](identity.ts) keeps it at
  the same instant by its code.
- `parcelAttributes.delivered` is a second delivery signal, so a delivery
  reported under a code we don't know yet is still recognised. It counts only
  when the newest row is unmapped or reads as delivered: Hermes also sets it on
  a return delivered to the sender, which stays returned.
- A parcel abroad its recipient did not collect from the parcel shop
  (`INTERNATIONAL_PUDO_NOT_COLLECTED`) goes back to the sender. A later
  `INTERNATIONAL_DELIVERED` is its hand-over on that way, so it reads as
  returned rather than delivered.
- Abroad, a partner such as PostNord, InPost or Correos delivers the parcel.
  The tracking page links the partner's tracking page as the international
  delivery partner (`viewParameters.internationalTrackingLink`). When the
  catalog's link rules read a carrier and its number from that link, on a host
  of that carrier's own links, they become `delivery_carrier` and
  `delivery_tracking_number`. A number's shape alone names no partner, since
  any host can carry one. The link is never followed.
- `EDL_BOOKED_DROPOFF` and `EDL_BOOKED_PARCELSHOP` are dropped: they are the
  recipient's delivery preference (a safe place, a ParcelShop), not a movement,
  and as the newest row they would move the parcel backwards.
- A Hermes Box is a pickup locker: the recipient asks the tracking page for a
  pickup code and takes the parcel out within 72 hours, as the
  [Hermes Box terms](https://www.myhermes.de/content/pdf/hermesbox_nutzungsbedingungen.pdf)
  say. `DELIVERED_PARCELBOX` is therefore ready for pickup, and so is any
  newest row that reads as delivered while the reply's
  `viewParameters.readyForParcelBoxCollection` is true, the flag the page
  shows its pickup-code form for. The delivered flag does not override
  either. A box delivery becomes delivered once a collection row follows it
  or Hermes sets that flag to false.
- `pickup_point` is the ParcelShop holding the parcel, or the one the recipient
  collected it from: the shop's name, street and town from the reply's
  `address` block, read only when its `addressType` is `PARCELSHOP` and the
  newest row says the parcel waits there or was collected there. A booked shop
  the parcel never reached gives none.
- Display text is `historyText`, with the mapped milestone description as
  fallback. The row's `status` field only holds generic buckets
  (`HAPPY`/`FINISHED`).
- Rows have no location field, so the place comes from the wording, in either
  language: the depot that took the parcel over or prepared it, the destination
  region, the destination country abroad, or the town of a ParcelShop's address
  on a ParcelShop row. Hermes's own depots and ParcelShops are in Germany, so
  their places end with it. No other address in the wording is read. A
  partner's German rows are read like its English ones, the country in brackets
  after "für den Weiterversand vorbereitet" or after "im Zielland"; no live
  German partner row has been seen.
- The postcode-protected endpoint that returns the delivery address is never
  called: the app doesn't store addresses and this carrier needs no postcode
  otherwise.
- `HermesGermanyTrackingError` keeps its name and 404 status: the host's grouped
  live suite asserts both.

## Limitations

- A row whose wording names no depot, region, country or ParcelShop has no
  location.
- A partner whose tracking links have no catalog rule, Austrian Post's for
  one, or a link to a home page leaves the partner unnamed.
- History expires: an old delivered number answers 404, shown as not found.
- Hermes answers 403 to some networks, including GitHub runners.
- The `address` block is read only for a ParcelShop. A home, neighbour or
  safe-place address and the delivery preferences in the payload are never
  read.

## Testing

Live coverage is in `testing/expandedCarriers.live.test.ts` (no env vars). It
accepts history or the 404 expiry, and skips on a 403/429 network block.
