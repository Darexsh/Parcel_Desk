# Ciblex

Tracks parcel labels and full barcodes through Ciblex's public extranet.
Each identifier is sent unchanged; routing digits are never extracted or used
as recipient verification.

## How it works

One bounded HTTP request retrieves the parcel page without session state.
Exactly one shipment banner must match the complete requested identifier before
its scan table is read. The official consumer form also forwards the full
barcode unchanged. Distinct parcel histories remain separate.

## Notes

The HTTP encoding takes precedence over the older HTML charset declaration.
Fully dated scans use the French portal clock and sort by instant with stable
ties. A scan dated by its day alone keeps that day as `local_time`. If a date is
unresolved, native position remains authoritative and its text is preserved. Unknown current wording cannot inherit older delivery.

The place column can contain recipient addresses. Only the established depot
labels with their department code are retained: `TOWN 68 (68)` as written, and
the town alone of `TOWN 44 (44 49X)` and of the origin hubs' `TOWN 69`, whose
codes are dropped. Written once, the department must be a French one. Exception
places are excluded. Customer and order blocks are ignored. Distinct native
places remain separate scans even when privacy rules suppress both. A scan
stored before its depot's town was read gains it in place.

"Acheminement contractuel du colis en 48h00" states the parcel's contractual
transit time beside a depot scan. It has no stage and never decides the
parcel's status. "COLIS NON REMIS" has no stage either: seen only before the
first scan, it can say the shipper did not hand the parcel over, while the same
words also say a parcel was not delivered.

Scans keep English wording for the labels the map reads, and "Ciblex tracking
update" for any other. The parcel app's review (`statusMap`) reads that wording,
or a copy's French label, so "Ciblex tracking update" stays open there, since
the stored scan does not keep the label.

Ciblex answers any number it has no scans for with the number's banner over an
empty table, whether the label is not scanned yet or was never issued. That
page is an answer without history, never proof of absence. Form errors, blank
responses, redirects and generic HTTP errors remain inconclusive.

## Testing

Set `CIBLEX_TRACKING_NUMBER` outside the repository and optionally
`CIBLEX_UNKNOWN_NUMBER`, then run
`npm run test:carriers:live -- carriers/ciblex`.
