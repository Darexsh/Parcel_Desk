# Fixtures

The pages follow the shape `/track/barcode/{number}` renders for one barcode: the status
heading, the barcode, a rail of four steps whose current one gives a place and a clock, a
summary line, the shipment facts, the proof-of-delivery box and the issue form. The style
rules are left out.

- `delivered.html` is a delivery scanned in Central Standard Time, with the delivery's
  proof-of-delivery details and the prompt for the photo.
- `received.html` is a parcel received at a terminal in Central Daylight Time, with a delivery
  estimate and the steps still to come.
- `not-found.html` is the notice for a barcode the tracker does not hold.
- `not-found-plain.html` is the same notice on the tracker's plain page, which carries only
  the lookup form and the notice.

Barcodes, places, clocks, weights, sizes and ids are invented.
