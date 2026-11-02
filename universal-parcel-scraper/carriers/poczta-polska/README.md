# Poczta Polska

Tracks registered postal items and parcel barcodes through the official
eMonitoring widget's anonymous JSON service. Detection names Poczta Polska for
the parcels, EMS, registered and tracked-letter items it issues: `C`, `E`, `L`
or `R` first, `PL` last and a passing check digit. Its tracker follows them
abroad with the partner post's scans. `CV` codes are left out: Meest's app
tracks parcels to Ukraine under them, and Poczta Polska's tracker has not
answered one. The
[UPU S10 standard](https://www.upu.int/UPU/media/upu/files/postalSolutions/programmesAndServices/standards/S10-12.pdf)
names the issuing country, not the deliverer, so its other `PL` codes stay with
the generic postal carrier, and recognition asks Poczta Polska about them
through the same lookup.

## How it works

The adapter reads public widget configuration from eMonitoring, then requests
one parcel's history. No account or browser is required. Both returned parcel
identifiers must match. A 19-digit reference receives the same check digit that
the official widget appends before lookup. Eighteen digits are the barcode's SSCC
without the GS1 application identifier `00` that labels print apart, so the
adapter puts it back; the service answers that parcel only under the whole barcode.

The service words its scans in Polish or English. A lookup whose `language` is
Polish asks for Polish, any other for English. The Polish answer can give an
item in delivery as another scan, under its own code, where the English gives
`P_WD`. Stages come from codes, and the identity policy in
[identity.ts](identity.ts) lets a scan worded in the other language take over
its stored row by provider code, instant and office.

Local detection checks complete numeric barcodes against the
[widget's check-digit calculation](https://emonitoring.poczta-polska.pl/widget/widget.tracking.min.js).
A barcode under Poczta Polska's own GS1 company prefix `5900773` whose check
digit holds, with or without its `00`, selects Poczta Polska, since the post
issues them; other SSCCs belong to their shippers. Shorter aliases have no
check digit to validate and remain shape-based suggestions.

## Notes

Specific scan codes determine progress. An unsuccessful delivery can carry the
broader “in delivery” state, so that state does not override the scan. The one
state read on its own is “returned”: from that scan on, the item travels back,
and a final delivery means the sender has it again. Weight is provided in
kilograms. Office names provide locations, except those that name a system or a unit with
no address: the transshipment terminal of a scan in transport, the sender platform and the
international postal system. A scan stored with one keeps its row. The office holding an item for
collection is its pickup point; a delivered item has none. The destination country is the two-letter code
the service gives, and the mail type, such as Pocztex or EMS, is the service name; office addresses, opening hours and payment documents are
excluded.

An item from abroad arrives at an inward office of exchange and passes customs
before delivery. Its collection at the office is a delivery. A customs
settlement can follow days later: it books the duty collected at delivery and
moves nothing, so the scan before it stays current. A delivery scan at a Polish
office dates the delivery.

## Limitations

Clocks carry no offset. A scan at a Polish office, which carries an office type,
is read on Polish time (`Europe/Warsaw`), and so is item data from Poczta
Polska's own sender platform, "Elektroniczny Nadawca", which has none. Scans
relayed from a partner post abroad, which carry no office type, show the
scanning office's wall clock. On an item another country's post numbered they
are read on that country's clock, and on one Poczta Polska numbered for abroad
on the destination's: a Latvian item's relayed posting and departure match
Latvijas Pasts's own instants that way. They keep their wall clock and say the
zone was deduced. Relayed scans from a country with several clocks (Spain and
Portugal count, for their islands), other office-less scans, and wall clocks
that a daylight-saving change skips or repeats keep their local digits. Scans keep the
provider's order. See [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) for
unresolved history handling. Empty history, invalidated scans, ambiguous
reused numbers and unregistered letter post, which the service answers with its mail type
alone, are inconclusive. Pallet consignments and references with linked
components need parcel-level history and are not supported.

## Testing

Run `npm run test:carriers:live -- carriers/poczta-polska`.
Set `POCZTA_POLSKA_TRACKING_NUMBER` outside the repository for a real parcel.
