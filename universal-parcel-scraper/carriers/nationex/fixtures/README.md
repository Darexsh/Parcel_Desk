# Fixtures

Each file follows the shape of the reply `GET /api/nationex/get-shipment/{number}` gives for one
shipment: its state and state history, the sender and recipient blocks, and each parcel with its
scans newest first, the expected day, help texts and state history. Numbers, depots, clocks,
references, postcodes, positions and the signer are invented.

- `delivered.json`: one parcel from the label to its delivery, with the photos and the message to
  the recipient next to the scans that record them.
- `transit.json`: one parcel between depots, with its expected day.
- `created.json`: only the label.
- `multi-parcel.json`: two parcels that share their first scans; one is delivered and the other
  is still out for delivery, so the shipment is partially delivered.
