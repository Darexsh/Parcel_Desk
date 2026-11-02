# Fixtures

Replies of `webDeliveryTracking`, the tracking page's lookup, with the fields it returns. Scans
come oldest first, each with its delivery status, operation status, transaction type, clock and
wording.

- `delivered.json`: a marketplace parcel from collection to a delivery at the door. One transfer
  scan is repeated, and the summary and the delivery scan carry the masked recipient, their
  address and the person who took the parcel, whose name the delivery's wording also names.
- `in-transit.json`: a parcel between two transfer centres.
- `returned.json`: a parcel that could not be delivered because it was damaged and went back to
  the sender. The return leg has a scan without a location, and two return scans share a clock.
- `return-pickup.json`: a customer's return, booked, collected from the customer by a courier
  whose scan names them, then at a branch. Its early scans are placed "with the recipient" and
  "in the delivery van".
- `not-found.json`: the answer for a number HepsiJET does not know.
- `not-received.json`: the answer for a number HepsiJET has no parcel for yet, as the page's
  script reads it.

Numbers, names, merchants, addresses, places and clocks are invented.
