# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/GetTrack` on
tracking.fgdelivery.it: one row per scan, newest first by `Progressivo`, each with the
shipment's number, the sender's reference, the recipient's postcode, name and delivery notes,
and the scan's date, clock, offset label, wording and code.

- `delivered.json` is a parcel whose sender's reference is a Cainiao code. It was delivered
  after a card was left, with the delivery recorded twice seconds apart and a branch scan
  listed twice. No reply has shown the code of the card left, so its `999` is invented.
- `in-transit.json` is at the delivering branch, under a sender's order reference.
- `not-found.json` is the empty list the tracker answers for a number it does not know.
- `blocked.html` is the tracking host's FortiWeb page for a refused request.

Numbers, references, names, postcodes, addresses and clocks are invented.
