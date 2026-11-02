# TransMission

TransMission is a partnership of independent transport and distribution companies that covers
the Netherlands, Belgium and Luxembourg. It is not Transmission, the Northern Ireland pallet
network. Its shipments are tracked by number and the recipient's postcode through the tracker's
own search form.

## How it works

1. `direct`: one `POST https://api.trans-mission.nl/Search-shipment` with the form fields
   `shipment_id` and `zipcode`, as the tracker's page submits them. It needs no cookie, token or
   browser. A shipment found under that number and postcode is answered with a redirect to its
   page, `/tt/{number}/{postcode}`, which the adapter then reads with one `GET`.
2. `retry`: one more try when the request fails to reach TransMission or hangs. The first try
   gets half of the budget.

- Otherwise the form comes back holding the number, with a notice. "Geen geldig
  zendingnummer" (not a valid shipment number) means the tracker knows no shipment with that
  number: `NotFoundError`. "Zending niet gevonden voor postcode" means the number is known but
  not under that postcode: `InputRequiredError` for `postcode` with reason
  `postcode_mismatch`, not a missing parcel. Any other notice, or none, is a schema change.
- The redirect and the page must name the shipment and postcode asked. A redirect elsewhere,
  or a page that sends the browser back, is inconclusive.
- A shipping unit's barcode goes into the same form, which opens its shipment's page. The
  adapter then reads only that unit's scans and weight.
- The page lists each unit's scans with their depot and search code. Units repeat the
  shipment's scans, and a delivery is logged under codes 39 and 0 on one clock, so equal scans
  are kept once. The depots' towns come from the progress rail.
- The search code decides a scan's stage: an early sorting scan can read "Bezorgtijd nog
  onbekend", the delivery estimate. Scans without a code fall back to their wording.
- Clocks are wall clocks without a zone, read in Dutch time.
- The sender, recipient, references, unit descriptions, contact details and the name of
  whoever took the parcel are never read.
- No recognition: every lookup needs the postcode.

## Numbers

A shipment number is `T` or `P`, a two-digit depot code and twelve digits, printed in groups
of two, six and six. Each shipping unit's barcode adds three digits to it. The tracker's own
lookups and a complaint show the shipment layout, which `transmission-1` claims with low
confidence: a letter and fourteen digits is too plain to name the carrier alone. Unit barcodes
stay unclaimed.

## Links

The tracker opens a shipment at `api.trans-mission.nl/tt/{number}/{postcode}`, an address that
holds the recipient's postcode. Only the number is read from such links, and the library builds
none.

## Limitations

- Nothing can be looked up without the postcode.
- Older scans came without a search code; those worded as the delivery estimate carry no stage.
- No signatory or proof of delivery.

## Testing

```sh
TRANSMISSION_TRACKING_NUMBER=... TRANSMISSION_POSTCODE=... TRANSMISSION_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/transmission
```
