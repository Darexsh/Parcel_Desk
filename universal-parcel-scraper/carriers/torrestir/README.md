# Torrestir

Torrestir is a Portuguese road carrier for parcels and pallets, with branches across Portugal,
on Madeira and the Azores, in Spain and in Germany. Tracked through the page its tracker
renders for one tracking code.

## How it works

1. `direct`: one `GET https://tracking.torrestir.com/?id={code}&lang=pt`, the address the
   tracker's own Portuguese button builds. It needs no cookie, token, key or browser. The
   tracker renders the page on its server: a card with the code and the shipment's details, and
   a table of scans, oldest first, each with its place, clock and wording.
2. `retry`: one more attempt after a network failure.

- The page repeats any code it is asked. A code it holds nothing for gets the card and the
  table empty, which is not found; the page has no other notice. A 404 or a redirect is a moved
  route, and a bot check's page is a challenge.
- Because of that echo, the page must also show Torrestir's own reference, the guia, whose
  number the code holds; a page for another guia, or for several shipments, is inconclusive.
- Recognition makes the same request.

## Notes

- Portuguese is asked for because the English and Spanish pages leave out some scans.
- Scan clocks are shown to the minute without a zone, and a warehouse is named without its
  country. Torrestir also scans on the Azores, an hour behind Lisbon, and in Spain and Germany,
  so the clocks stay `local_time`. The guia's creation comes at midnight exactly, which is its
  day.
- A scan's place is a warehouse, `ARM. TOWN`, or the leg it belongs to, such as `Em Viagem`
  (on the road) or `Destinatário`. The warehouse's town and the coordinates the page gives it
  are kept; a leg is not a place.
- The scans carry no code; their wordings are mapped and any other goes to the shared wording
  rules. `Devolvido` is a parcel brought back to the warehouse from a delivery round, which then
  goes out again, so it is a failed attempt rather than a return to the sender.
- The estimate's day is kept until the delivery; its window is not. The customer that booked
  the shipment and its reference, the guia, the origin and destination towns and the parcel and
  pallet counts are not kept. The progress bar is not read.
- The page names no other carrier or number, so there is no hand-off.

## Limitations

- No provider codes, offsets, weight or proof of delivery.
- The tracker opens only the tracking code; it does not find a parcel by its guia.

## Numbers

Its tracker shows a tracking code, the sender's reference and Torrestir's own reference.

The tracking code is M001, four digits, a letter or digit, and eleven digits that hold the
zero-padded guia number and one more digit. Customers quote it in Portal da Queixa complaints,
and Torrestir's own emails head a delivery with it. `torrestir-1` claims it with high
confidence; no other carrier's corpus or rule has the shape.

Torrestir's reference is the guia de transporte, written as 0, 10, one digit and eight digits
separated by dots. Customers and Torrestir's claim files quote it, and Torrestir also writes
the bare eight digits. Without its dots the dotted form is a twelve-digit run, and the bare
form is an eight-digit run; many carriers share both shapes, so no rule claims either.

A Spanish sender can hand a parcel to CBL Logística, which passes it to Torrestir in Portugal.
The tracking code such a sender gives stays in quarantine until a source ties it to
Torrestir's own network.

## Links

The tracker at `tracking.torrestir.com` opens one parcel from its `id` parameter, the address
the Track & Trace box on `www.torrestir.com` builds. The site builds it on `http`, which
redirects to the same address on `https`.

## Testing

`npm run test:carriers:live -- carriers/torrestir`, with `TORRESTIR_TRACKING_NUMBER` and
optionally `TORRESTIR_UNKNOWN_NUMBER` set outside the repository.
