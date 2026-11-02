# Fixtures

The files follow the shape of the tracking service's reply: the item's barcodes, flags for
charges and declarations, a masked recipient and locality, and the scans newest first, each with
a UPU event code, wording, a clock and a place, and for a hold or a failed delivery a reason and
an action. Barcodes, places, recipients and clocks are invented. `sendon.json` is a SendOn item
under its MaltaPost and foreign barcodes, cleared, paid for and delivered to the door;
`returned.json` an item from abroad that waited at a post office and went back to its sender;
`charges.json` an item from abroad held until its charges are paid. `not-found.json` is the reply
for a barcode MaltaPost does not know.
