# Fixtures

The JSON files follow the reply of the tracker's `/api/scannungen/{barcode}`: every scan of the
barcode, newest first, with the place, remark and postcode fields empty as the reply leaves them
without the recipient's postcode.

`delivered.json` goes from the sender readying the parcel to the delivery, through a night it
waited at the branch, with one arrival scan repeated. `in-transit.json` reaches a branch in the
hour the clocks repeat when they go back. `not-found.json` is the answer for a barcode the
tracker does not know.

Barcodes, branch and consignment numbers and clocks are invented. The wordings are the tracker's.
