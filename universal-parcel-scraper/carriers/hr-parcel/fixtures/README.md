# Fixtures

The fixtures follow the reply of the tracking page's barcode search: `shipment` and `steps`
as the page shows them, newest scan first, and `response`, the shipment service's own record.
`delivered.json` goes from the sender's data to a door delivery after the recipient was out
and the parcel was held at the branch; one branch scan is repeated, and the service's record
carries a signatory, an order reference and an item description. `in-transit.json` is one of
a two-parcel shipment's barcodes, at the delivering branch, whose town gives its province
twice. `not-found.json` is the answer for a number HR Parcel does not know.

Numbers, references, names and clocks are invented.
